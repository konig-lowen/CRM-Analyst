# AUDIT_PHASE8 — Evolução Estratégica
**Data:** 2026-05-20  
**Auditor:** Jarvis (subagente)  
**Objetivo:** Proposta de evolução do CRM Analyst de "chat com CRM" para **motor de inteligência operacional comercial**

---

## Contexto do Sistema Atual

- **Stack:** Node.js + Express + SQLite (better-sqlite3) + API Ploomes
- **Arquitetura:** Monolito com três bancos: `history.db` (app/sessões), `sessions.db`, `warehouse.db` (ETL)
- **Pontos fortes:** Chat AI, Coach AI personalizado, dashboard live, ranking, warehouse histórico
- **Lacunas principais:** Sem scores preditivos, sem memória persistente por vendedor, sem alertas proativos automáticos, sem event sourcing de deals

---

## 1. Engine de Insights

### Visão

Transformar o CRM Analyst em um sistema que **detecta, classifica e alerta** sobre oportunidades e riscos sem precisar de perguntas manuais.

### Arquitetura Proposta

```
┌─────────────────────────────────────────────────────────┐
│                    INSIGHTS ENGINE                       │
│                                                         │
│  Fonte          Pipeline          Saída                  │
│  ──────         ────────          ─────                  │
│  API Ploomes ─► Normalização ─►  Scores por deal         │
│  warehouse.db   (deals,tasks,     Alertas por vendedor   │
│  history.db     interactions)     Feed proativo          │
│                     │                                    │
│              ┌──────┴──────┐                             │
│              │  Rules Layer │  (determinístico, rápido)  │
│              │   AI Layer   │  (LLM, custoso, por demanda│
│              └─────────────┘                             │
└─────────────────────────────────────────────────────────┘
```

### 1.1 Scores por Deal (Rules Layer — 100% determinístico)

Implementar em `server.js` como função `computeDealScores(deals, interactions, tasks)`:

```javascript
// Tabela de scores de risco por deal
// Score 0-100: 0 = sem risco, 100 = risco crítico de perda

function scoreDealRisk(deal, interactions, tasks) {
  let score = 0;
  const now = Date.now();
  const lastUpdate = deal.LastUpdateDate ? new Date(deal.LastUpdateDate).getTime() : 0;
  const daysSinceUpdate = (now - lastUpdate) / 86400000;
  const daysSinceCreation = (now - new Date(deal.CreateDate).getTime()) / 86400000;

  // Regras determinísticas
  if (daysSinceUpdate > 30) score += 30;         // Parado há >30 dias
  if (daysSinceUpdate > 60) score += 20;         // Parado há >60 dias (cumulativo)
  if (!deal.Amount || deal.Amount === 0) score += 15;  // Sem valor cadastrado
  const dealInteractions = interactions.filter(i => i.DealId === deal.Id);
  if (dealInteractions.length === 0) score += 20; // Sem nenhuma interação
  const overdueTasks = tasks.filter(t => t.DealId === deal.Id && !t.Finished && t.DateTime && new Date(t.DateTime) < now);
  score += Math.min(20, overdueTasks.length * 5); // Tarefas vencidas
  if (daysSinceCreation > 120) score += 10;       // Deal muito antigo (> ciclo médio esperado)

  return Math.min(100, score);
}
```

**Scores implementáveis sem LLM:**
- `riskScore` (0-100): risco de perda do deal
- `staleness` (dias sem atualização): deals esfriando
- `activityScore` (interações/semana): engajamento no deal
- `completenessScore` (% de campos preenchidos): qualidade do dado

### 1.2 Score de Produtividade do Vendedor (Rules Layer)

```javascript
function scoreVendedorProductivity(ownerId, { deals, interactions, tasks, goals }) {
  // Inputs: dados do mês atual
  const wonDeals = deals.filter(d => d.OwnerId === ownerId && d.StatusId === 2);
  const openDeals = deals.filter(d => d.OwnerId === ownerId && d.StatusId === 1);
  const interacoes = interactions.filter(i => i.CreatorId === ownerId);
  const overdueTasks = tasks.filter(t => t.OwnerId === ownerId && !t.Finished && isOverdue(t));
  const staleOpenDeals = openDeals.filter(d => daysSince(d.LastUpdateDate) > 30);

  const goal = goals.find(g => g.ploomes_user_id === ownerId);
  const metaProgress = goal?.valor_mensal > 0
    ? wonDeals.reduce((s, d) => s + (d.Amount || 0), 0) / goal.valor_mensal
    : null;

  return {
    score: calculateWeightedScore({ wonDeals, interacoes, overdueTasks, staleOpenDeals, metaProgress }),
    signals: { wonDeals: wonDeals.length, interacoes: interacoes.length, staleDeals: staleOpenDeals.length, overdueTasksCount: overdueTasks.length, metaProgress }
  };
}
```

### 1.3 Detecção de Anomalias

**Implementar job periódico `detectAnomalies()` rodando via `setInterval` a cada 6h:**

```javascript
const ANOMALY_RULES = [
  { id: 'deal_stalled',    check: (d) => daysSince(d.LastUpdateDate) > 21 && d.StatusId === 1,
    severity: 'warning',  message: (d) => `Deal "${d.Title}" sem atualização há ${daysSince(d.LastUpdateDate)}d` },
  { id: 'deal_lost_spike', check: (owner, period) => owner.lostCount > owner.avgLost * 2.5,
    severity: 'critical', message: (o) => `${o.name}: perdas ${o.lostCount}x acima da média histórica` },
  { id: 'no_activity',     check: (o) => o.interactionsLast7d === 0 && o.openDeals > 0,
    severity: 'warning',  message: (o) => `${o.name}: sem nenhuma interação nos últimos 7 dias` },
  { id: 'quota_risk',      check: (o, g) => g && getMonthProgress() > 0.7 && o.metaProgress < 0.4,
    severity: 'critical', message: (o) => `${o.name}: 70% do mês passado, apenas 40% da meta atingida` },
];

async function detectAnomalies() {
  const results = await runAllRules(ANOMALY_RULES);
  // Salva em tabela `anomaly_alerts` no history.db
  // Dispara notificação se severity === 'critical'
}
```

**Schema da tabela `anomaly_alerts`:**
```sql
CREATE TABLE IF NOT EXISTS anomaly_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,  -- 'info'|'warning'|'critical'
  target_type TEXT,        -- 'deal'|'owner'|'team'
  target_id TEXT,
  message TEXT NOT NULL,
  data_json TEXT,          -- contexto serializado
  detected_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  notified INTEGER DEFAULT 0
);
```

### 1.4 Sistema de Alertas Proativos

**Integrar alertas ao chat (SSE ou polling):**

```javascript
// Endpoint para alertas do usuário logado
app.get('/api/alerts', requireAuth, (req, res) => {
  const ploomesId = req.session.ploomesUserId;
  const unresolved = db.prepare(`
    SELECT * FROM anomaly_alerts
    WHERE (target_id = ? OR target_type = 'team')
      AND resolved_at IS NULL
      AND detected_at >= datetime('now', '-7 days')
    ORDER BY severity DESC, detected_at DESC
    LIMIT 10
  `).all(String(ploomesId));
  res.json(unresolved);
});
```

**Esforço:** M | **Stack:** Node.js nativo + SQLite | **Impacto:** Alto — transforma o sistema de reativo para proativo

---

## 2. Memória Comercial Persistente

### Visão

Cada vendedor tem um perfil acumulativo que evolui ao longo do tempo. O Coach AI pode acessar esse histórico para personalizar recomendações.

### 2.1 Estrutura das Tabelas SQLite

```sql
-- Perfil comportamental acumulativo por vendedor
CREATE TABLE IF NOT EXISTS vendor_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_user_id INTEGER NOT NULL REFERENCES app_users(id),
  period TEXT NOT NULL,         -- 'YYYY-MM' ou 'YYYY-WNN'
  period_type TEXT NOT NULL,    -- 'month'|'week'
  
  -- Métricas calculadas do período
  deals_won INTEGER DEFAULT 0,
  deals_lost INTEGER DEFAULT 0,
  deals_opened INTEGER DEFAULT 0,
  revenue_won REAL DEFAULT 0,
  interactions_total INTEGER DEFAULT 0,
  interactions_visit INTEGER DEFAULT 0,
  tasks_ontime INTEGER DEFAULT 0,
  tasks_overdue INTEGER DEFAULT 0,
  stale_deals INTEGER DEFAULT 0,
  win_rate REAL,              -- calculado
  avg_cycle_days REAL,
  avg_ticket REAL,
  
  -- Padrões inferidos (rules-based, atualizados mensalmente)
  behavior_profile TEXT,       -- JSON: { label, signals }
  
  -- Snapshot de metas
  goal_revenue REAL,
  goal_interactions INTEGER,
  meta_progress REAL,          -- 0.0–1.0
  
  computed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(app_user_id, period, period_type)
);

-- Event sourcing parcial de deals (mudanças de estado)
CREATE TABLE IF NOT EXISTS deal_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL,
  owner_id INTEGER,            -- Ploomes OwnerId
  pipeline_id INTEGER,
  event_type TEXT NOT NULL,    -- 'created'|'stage_changed'|'won'|'lost'|'stalled'|'reopened'
  from_value TEXT,             -- stage anterior, status anterior
  to_value TEXT,               -- novo stage, novo status
  amount REAL,
  event_at TEXT,               -- data do evento (de FinishDate/LastUpdateDate)
  detected_at TEXT DEFAULT (datetime('now')),
  metadata_json TEXT           -- dados adicionais serializados
);

-- Timeline operacional por deal
CREATE TABLE IF NOT EXISTS deal_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER NOT NULL,
  entry_type TEXT NOT NULL,    -- 'interaction'|'task'|'stage_change'|'alert'|'coach_note'
  owner_id INTEGER,
  summary TEXT,
  detail_json TEXT,
  occurred_at TEXT,
  recorded_at TEXT DEFAULT (datetime('now'))
);

-- Contexto persistente para o Coach AI
CREATE TABLE IF NOT EXISTS coach_context (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_user_id INTEGER NOT NULL REFERENCES app_users(id),
  context_key TEXT NOT NULL,   -- 'strengths'|'weaknesses'|'goals'|'patterns'|'coach_notes'
  content TEXT NOT NULL,       -- Texto livre ou JSON
  confidence REAL DEFAULT 1.0, -- 0.0–1.0
  source TEXT,                 -- 'computed'|'coach_ai'|'manual'
  valid_from TEXT DEFAULT (datetime('now')),
  valid_until TEXT,            -- NULL = sem expiração
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(app_user_id, context_key)
);
```

### 2.2 Job de Consolidação Mensal

```javascript
// Rodar no dia 1 de cada mês às 03:00 UTC (via setInterval ou node-cron)
async function consolidateMonthlyVendorMemory(yearMonth) {
  const users = db.prepare('SELECT * FROM app_users WHERE active = 1').all();
  for (const user of users) {
    if (!user.ploomes_user_id) continue;
    const metrics = await computeMonthMetrics(user.ploomes_user_id, yearMonth);
    const profile = inferBehaviorProfile(metrics);
    
    db.prepare(`
      INSERT OR REPLACE INTO vendor_memory 
        (app_user_id, period, period_type, ..., behavior_profile, computed_at)
      VALUES (?, ?, 'month', ..., ?, datetime('now'))
    `).run(user.id, yearMonth, ..., JSON.stringify(profile));
    
    // Atualizar coach_context com insights do mês
    upsertCoachContext(user.id, 'patterns', summarizePatterns(metrics));
  }
}
```

### 2.3 Uso no Coach AI

```javascript
// No buildSystemPrompt() do Coach, injetar contexto persistente:
const coachCtx = db.prepare(`
  SELECT context_key, content FROM coach_context
  WHERE app_user_id = ? AND (valid_until IS NULL OR valid_until > datetime('now'))
  ORDER BY updated_at DESC
`).all(targetUserId);

const vendorHistory = db.prepare(`
  SELECT * FROM vendor_memory
  WHERE app_user_id = ? ORDER BY period DESC LIMIT 6
`).all(targetUserId);

// Injetar no system prompt como:
// ## HISTÓRICO DE PERFORMANCE (últimos 6 meses)
// Março/26: 3 ganhos, R$45k, win rate 42%, perfil: "consultivo"
// Fevereiro/26: 5 ganhos, R$72k, win rate 55%, perfil: "equilibrado"
// ...
// ## PADRÕES IDENTIFICADOS (persistente)
// Pontos fortes: fechamento em visitas presenciais, follow-up consistente
// Atenção: deals de baixo valor acumulando sem fechamento
```

**Esforço:** G | **Stack:** SQLite (4 tabelas novas) + cron interno | **Impacto:** Alto — Coach AI sai de "sem memória" para "coach que acompanha a evolução"

---

## 3. Chat Orientado à Ação

### Visão

O chat atual responde perguntas. O novo chat **sugere o que fazer agora** com base em contexto real.

### 3.1 Priorização Automática da Agenda

**Novo endpoint `GET /api/agenda-hoje`:**

```javascript
app.get('/api/agenda-hoje', requireAuth, async (req, res) => {
  const ownerId = req.session.ploomesUserId;
  
  // Buscar dados necessários
  const [dealsOpen, tasks, interactions7d] = await Promise.all([...]);
  
  // Gerar lista priorizada
  const agenda = [];
  
  // 1. Tarefas vencidas hoje
  const overdue = tasks.filter(t => isOverdue(t) && !t.Finished);
  agenda.push(...overdue.map(t => ({ priority: 1, type: 'task_overdue', action: `Tarefa vencida: ${t.Title}`, dealId: t.DealId })));
  
  // 2. Deals com score de risco alto
  const riskDeals = dealsOpen.filter(d => computeDealRiskScore(d, interactions7d) > 70);
  agenda.push(...riskDeals.map(d => ({ priority: 2, type: 'deal_risk', action: `Deal em risco: ${d.Title} (${daysSince(d.LastUpdateDate)}d sem atualização)`, dealId: d.Id })));
  
  // 3. Oportunidades quentes (alta atividade recente)
  const hot = dealsOpen.filter(d => recentInteractions(d.Id, interactions7d) > 3);
  agenda.push(...hot.map(d => ({ priority: 3, type: 'deal_hot', action: `Oportunidade aquecida: ${d.Title}`, dealId: d.Id })));
  
  // Ordenar e limitar a 10 itens
  res.json(agenda.sort((a,b) => a.priority - b.priority).slice(0, 10));
});
```

### 3.2 Recomendações Operacionais Concretas no Chat

**Injetar contexto de agenda no prompt do Coach:**

```javascript
// Em /api/chat/coach, antes de chamar a LLM:
const agenda = await getAgendaHoje(ownerId);
const agendaText = agenda.slice(0,5).map(a => `- [${a.type}] ${a.action}`).join('\n');

// Adicionar ao system prompt:
// ## AGENDA OPERACIONAL DO DIA
// - [deal_risk] Deal "Compressores Salete" sem contato há 18 dias → ligue hoje
// - [task_overdue] Follow-up proposta para Metalúrgica XYZ venceu ontem
// - [deal_hot] "Ar comprimido Fábrica Nova" teve 4 interações essa semana → momento de avançar para proposta
```

### 3.3 Alertas Inteligentes no Chat (Feed Proativo)

**Componente de feed no app.html:**

```javascript
// Polling a cada 30min enquanto usuário está logado
// GET /api/alerts → retorna alertas não visualizados
// Exibir como toast notification ou badge no ícone de chat

// Formatos de alerta:
// 🔴 CRÍTICO: Você está em 22% da meta, faltam 8 dias úteis no mês
// 🟡 ATENÇÃO: 3 deals sem atualização há mais de 30 dias
// 💡 DICA: Rafael fechou 2 deals essa semana usando visita + follow-up email — padrão que também funciona bem para você
```

### 3.4 Feed de Tarefas Prioritárias (Widget no Dashboard)

**Novo card no dashboard.html:**

```html
<!-- Widget: Faça agora -->
<div class="card" id="agendaCard">
  <div class="k">📋 Faça agora</div>
  <div id="agendaList" class="list">
    <!-- preenchido por GET /api/agenda-hoje -->
  </div>
</div>
```

**Esforço:** M | **Stack:** Node.js + 1-2 novos endpoints + alterações no frontend | **Impacto:** Alto — maior diferencial percebido pelo vendedor no dia a dia

---

## Roadmap de Implementação

| Fase | Proposta | Esforço | Impacto | Pré-requisito |
|------|----------|---------|---------|---------------|
| 1 | Deal risk score (rules-based) + tabela `anomaly_alerts` | P | Alto | Nenhum |
| 2 | Widget "Faça agora" no dashboard + endpoint `/api/agenda-hoje` | P | Alto | Fase 1 |
| 3 | Tabela `vendor_memory` + job mensal de consolidação | M | Alto | Nenhum |
| 4 | `coach_context` + injeção de histórico no Coach AI | M | Muito alto | Fase 3 |
| 5 | `deal_events` + event sourcing parcial no sync ETL | M | Médio | warehouse.db |
| 6 | Alertas proativos no chat (SSE ou polling) | M | Alto | Fase 1 + 4 |
| 7 | Rebalancear ScoreCRM (receita + % meta) | P | Alto | Nenhum |
| 8 | Rankings por funil + normalização por meta | M | Médio | Fase 7 |
| 9 | Score AI de oportunidade (LLM-based, batch) | G | Alto | Fases 1-5 |

---

## Quick Wins (implementáveis em 1 sprint)

1. **Tabela `anomaly_alerts` + job a cada 6h detectando deals parados** → alertas imediatos no dashboard
2. **Widget "Faça agora" no dashboard** com top 5 prioridades do dia → maior impacto percebido pelo vendedor
3. **Rebalancear ScoreCRM** para incluir receita como componente principal
4. **Injetar `vendor_memory` simplificado** no Coach AI (apenas últimos 3 meses de métricas) → Coach mais personalizado imediatamente

---

## Considerações de Arquitetura

- **SQLite é suficiente** para todas as propostas. Não há necessidade de migrar para PostgreSQL antes de 50+ usuários ativos com queries concorrentes pesadas.
- **Sem infraestrutura nova necessária.** Tudo pode rodar no mesmo processo Node.js com `setInterval` para jobs periódicos — ou migrar para `node-cron` para melhor controle.
- **LLM apenas onde necessário.** Rules layer cobre 80% dos casos de insight. LLM entra apenas para síntese qualitativa (Coach AI, análise de padrões complexos).
- **Compatibilidade total** com o stack atual. Nenhuma dependência nova crítica — apenas mais tabelas SQLite e funções no server.js.

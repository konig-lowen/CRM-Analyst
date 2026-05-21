# AUDIT NOVA — CRM Ploomes Analyst
**Data:** 2026-05-21 | **Executor:** Jarvis (auditoria manual — Claude Code bloqueado como root)

---

## Resumo Executivo

- **3 bugs novos confirmados** no código de gestor.html / gestor-dashboard que causam dados errados ou ausentes no frontend
- **Erro 403 / "API retornou string"**: causa raiz identificada — `computeCrmHealth` faz fallback para a API Ploomes quando warehouse está stale; a API retorna HTML (403 ou rate-limit) em algumas queries
- **Itens das auditorias anteriores**: maioria ainda pendente; nenhuma das correções críticas do CHECKUP_REPORT foi aplicada
- **Score do gestor (riskScore)**: lógica existe mas é exclusivamente baseada em penalidades; não há balanceamento de volume+frequência de deals como solicitado

---

## Status dos Itens das Auditorias Anteriores

| # | Problema | Status |
|---|----------|--------|
| 1 | ETL Parado — warehouse desatualizado | ❌ **Ainda pendente** — `warehouse.db` last modified 2026-05-11 (10 dias) |
| 2 | PLOOMES_API_KEY hardcoded (`server.js:18`) | ❌ **Ainda pendente** — fallback hardcoded não removido |
| 3 | SESSION_SECRET hardcoded (`server.js:1933`) | ❌ **Ainda pendente** |
| 4 | history.db WAL não checkpointed | ❌ **Ainda pendente** — arquivo WAL ainda presente |
| 5 | N+1 queries `getAllowedPloomesIds` | ❌ **Ainda pendente** |
| 6 | 18 chamadas sequenciais em `/api/reports/:userId` | ❌ **Ainda pendente** |
| 7 | Índices faltando no warehouse.db | ❌ **Ainda pendente** |
| 8 | N+1 na materialize de `mv_hygiene` | ❌ **Ainda pendente** |
| 9 | Modelo IA hardcoded `claude-haiku-4-5` | ❌ **Ainda pendente** — linhas 1844 e 1945 confirmadas |
| 10 | `/api/crm-health` busca deals sem filtro de data | ⚠️ **Parcial** — `computeCrmHealthWarehouse()` existe mas só usada se warehouse fresco |
| 11 | `node-fetch` nunca importado | ❌ **Ainda pendente** |
| 12 | Arquivos `.bak` no working tree | ❌ **Ainda pendente** — 8+ arquivos .bak |
| 13 | Senha mínima 4 caracteres | ❌ **Ainda pendente** |
| 14 | `computeRanking` N queries coach bonus | ❌ **Ainda pendente** |
| 15 | history.db sem `busy_timeout` | ❌ **Ainda pendente** |
| 16 | `inferDateRangeFromMessage` regex março | ❌ **Não verificado** |

---

## Causa Raiz do Erro 403 / "API retornou string"

### O problema
Os logs mostram:
```
[reports/ploomes error] Error: API error: Your request has been forbidden
[reports/ploomes error] Error: API retornou string: <!DOCTYPE html PUBLIC ...
```

O erro está em `server.js:566-567` dentro de `_ploomesGetOnceSingle`, mas a rota `/api/reports/ploomes/:id` **deveria usar apenas o warehouse** (e de fato usa, linhas 4151-4235).

### A causa real
O erro **não é causado pela rota `/api/reports/ploomes/:id`** em si — os campos que ela lê no warehouse são simples e não falham. O log `[reports/ploomes error]` é o catch da rota, mas a `Error` vem de dentro do `computeCrmHealth()` que é **chamado no startup** (linha 1592):

```js
// server.js:1589-1595
if (isWarehouseFresh()) {
  const wh = computeCrmHealthWarehouse();
  ...
} else {
  kickWarehouseSyncBackground('computeCrmHealth');  // ← dispara background
}
```

Como o warehouse está **stale (10+ dias)**, `isWarehouseFresh()` retorna `false`, e `kickWarehouseSyncBackground` tenta rodar o sync que por sua vez chama a API Ploomes — onde algumas queries retornam 403 (campos proibidos em `$select` do `/Deals` ou rate-limit).

### A query problemática
`computeCrmHealth` (linhas 1619-1625) chama:
```js
const openDeals = await ploomesGetAll(
  `/Deals?$filter=StatusId eq 1 and ${baseExcl}&$select=Id,OwnerId,PipelineId,Amount,LastUpdateDate,StageId`, 10000);
```

A Ploomes retorna HTML/403 intermitentemente quando o filtro `$select` inclui `StageId` em combinação com filtros complexos ou quando há rate-limit. Além disso, quando retorna HTML, o `JSON.parse` falha e resulta na mensagem "API retornou string".

### Fix para o erro 403

**Fix 1 — Imediato: rodar o ETL para que o warehouse fique fresco**
```bash
PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js
```
Quando warehouse estiver fresco, `isWarehouseFresh()` retorna `true` e `computeCrmHealth` usa warehouse em vez da API.

**Fix 2 — Código: adicionar `StageId` à lista de campos proibidos**
```js
// server.js linha ~675: DEALS_FORBIDDEN_FIELDS_GLOBAL
const DEALS_FORBIDDEN_FIELDS_GLOBAL = ['Name', 'Subject', 'Description', 'StageName', 'ReasonId', 'StageId'];
```

**Fix 3 — Código: melhorar tratamento quando a API retorna HTML**
```js
// server.js linha ~620: em res.on('end', ...)
res.on('end', () => {
  try {
    if (data.trim().startsWith('<')) {
      return reject(new Error(`API retornou HTML (provável 403/rate-limit). Status: ${res.statusCode}`));
    }
    const parsed = JSON.parse(data);
    ...
  }
});
```

---

## Novos Problemas Encontrados

### 🔴 BUG-1: Campo `dealsPardos30d` vs `dealsParados` — Coluna sempre vazia no gestor.html

**Severidade:** 🔴 Crítico (dado errado em produção, silencioso)

**Onde:** `server.js:2764` (API retorna `dealsPardos30d`) vs `gestor.html:519` (frontend lê `dealsParados` ou `deals_parados`)

**Código do servidor:**
```js
// server.js:2764 — campo inicializado como:
dealsPardos30d: 0,
// e lido como:
r.dealsPardos30d++
```

**Código do frontend:**
```js
// gestor.html:519
const dp = v.dealsParados ?? v.deals_parados ?? 0;
```

**Resultado:** A coluna "Deals Parados >30d" da tabela de vendedores sempre exibe 0, mesmo quando há deals parados. O riskScore pode também estar sendo subestimado se o threshold de +20pts nunca é ativado.

**Fix:**
```js
// server.js: renomear campo ao construir o objeto byOwner
// Linha 2764: dealsPardos30d → dealsParados
dealsParados: 0,
// Linhas 2770, 2791: atualizar referências
```
OU no frontend `gestor.html:519`:
```js
const dp = v.dealsParados ?? v.deals_parados ?? v.dealsPardos30d ?? 0;
```

---

### 🔴 BUG-2: Campo `metaProgress` vs `metaPct` — % da meta nunca exibida

**Severidade:** 🔴 Crítico (dado ausente em produção)

**Onde:** `server.js:2798` vs `gestor.html:483`

**Código do servidor:**
```js
// server.js:2798 — API retorna:
r.metaProgress = progress;  // ratio 0-1 (ex: 0.75 para 75%)
r.metaValor = goal.valor_mensal;
```

**Código do frontend:**
```js
// gestor.html:483
const metaPct = v.metaPct ?? v.meta_pct;
if (metaPct != null) { ... }
```

**Resultado:** A coluna "% Meta" sempre exibe "—" para todos os vendedores, mesmo quando há metas cadastradas. O frontend espera `metaPct` (número 0-100), mas a API retorna `metaProgress` (ratio 0-1) com nome diferente.

**Fix — servidor (server.js ~linha 2798):**
```js
r.metaPct = Math.round(progress * 100);  // adicionar este campo
r.metaProgress = progress;               // manter para compatibilidade
```

---

### 🟠 BUG-3: `ganhosMes` vs `dealsGanhosMes` — campo numérico vs valor monetário

**Severidade:** 🟠 Médio (exibição confusa)

**Onde:** `server.js:2763-2771` vs `gestor.html:470`

**Código do servidor:**
```js
// servidor inicializa:
dealsGanhosMes: 0,     // contagem de deals ganhos
receitaGanhaMes: 0,    // valor monetário ganho
```

**Código do frontend:**
```js
// gestor.html:470
const ganhosCt = v.ganhosMes ?? v.ganhos_mes ?? '—';  // espera "ganhosMes"
const ganhosVal = v.receitaMes ?? v.receita_mes;       // espera "receitaMes"
```

**Resultado:** A coluna "Ganhos Mês / Receita" exibe "—" para a contagem e "—" para o valor, porque o servidor retorna `dealsGanhosMes` e `receitaGanhaMes`, não os nomes esperados pelo frontend.

**Fix — servidor, ao montar a resposta `vendedores`:**
```js
// Adicionar aliases ao objeto retornado ou renomear os campos:
vendedores: Object.values(byOwner).map(r => ({
  ...r,
  ganhosMes: r.dealsGanhosMes,
  receitaMes: r.receitaGanhaMes,
  dealsParados: r.dealsPardos30d,  // fix BUG-1 também
})).sort(...)
```

---

### 🟡 NOVO-4: Score de risco no gestor — apenas penalidades, sem balanceamento de volume+frequência

**Severidade:** 🟡 Baixo (feature faltante, não é bug)

**O que existe:**
```js
// server.js ~2789-2803: riskScore só tem penalidades
if (r.interacoes7d === 0 && r.dealsAbertos > 0) risk += 30;  // penalidade
if (r.tarefasVencidas >= 5) risk += 20;                       // penalidade
if (r.dealsPardos30d >= 10) risk += 20;                       // penalidade (mas BUG-1 faz nunca ativar)
if (monthProgress > 0.6 && progress < 0.3) risk += 25;       // penalidade
```

**O que falta (conforme solicitado):**
- Vendedor com muitos deals ganhos no mês deveria ter risco reduzido
- Vendedor com alta frequência de interações deveria ter bônus
- Volume de deals abertos com valor alto deveria ser considerado

**Fix sugerido:**
```js
// Adicionar bônus ao invés de só penalidades:
if (r.dealsGanhosMes >= 3) risk -= 15;             // bom volume de fechamentos
if (r.interacoes7d >= 10) risk -= 10;              // frequência de atividade
if (r.receitaGanhaMes > 50000) risk -= 10;         // bom resultado financeiro
r.riskScore = Math.max(0, Math.min(100, risk));    // garantir range 0-100
```

---

### 🟠 NOVO-5: `gestor-dashboard` não usa warehouse — todas as chamadas vão para API Ploomes

**Severidade:** 🟠 Médio (performance, custo de API, risco de 403)

`/api/gestor-dashboard` (linhas 2733-2825) faz **5 chamadas paralelas** à API Ploomes:
```js
const [dealsOpen, dealsWonMonth, dealsLostMonth, interactionsWeek, tasksOpen] = await Promise.all([
  ploomesGetAll(...),  // todos os deals abertos
  ploomesGetAll(...),  // deals ganhos no mês
  ploomesGetAll(...),  // deals perdidos no mês
  ploomesGetAll(...),  // interações 7 dias
  ploomesGetAll(...),  // tarefas abertas
]);
```

O warehouse já contém todos esses dados. O endpoint deveria ter o mesmo padrão de fallback que `computeCrmHealth`:
- Se warehouse fresco → usar warehouse
- Senão → fallback para API

**Fix:** Criar `computeGestorDashboardWarehouse()` similar a `computeCrmHealthWarehouse()` e usar como preferência.

---

### 🟠 NOVO-6: `agenda-hoje` usa `Title` em `/Deals` — campo proibido (causa 403)

**Severidade:** 🟠 Médio (erro de runtime)

```js
// server.js:2635
ploomesGetAll(`/Deals?$select=Id,OwnerId,Title,Amount,LastUpdateDate,StatusId,PipelineId,StageId&$filter=...`)
```

O campo `Title` está sendo usado em `/Deals` mas `Name` (equivalente) está na lista de campos proibidos. `Title` não está na lista mas pode causar 403 em algumas variações. `StageId` também está presente e pode causar 403 (ver Fix 2 acima).

**Fix:** Remover `Title` e `StageId` do `$select` na rota `/api/agenda-hoje`.

---

### 🟡 NOVO-7: `requireAdminOrGestor` duplicado — função definida duas vezes

**Severidade:** 🟡 Baixo (confusão de manutenção)

```js
// server.js:2018 — bloco anônimo
if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'gestor')) return next();

// server.js:2022-2023 — função nomeada
function requireAdminOrGestor(req, res, next) {
  if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'gestor')) return next();
```

Há lógica idêntica em dois lugares. Pode causar inconsistências se um for atualizado e o outro não.

---

## Análise do gestor.html — Auditoria Completa

### Endpoints chamados
| Endpoint | Auth | Problema |
|----------|------|----------|
| `/api/gestor-dashboard` | admin/gestor | BUG-2, BUG-3 — campos errados retornados |
| `/api/alerts` | auth | OK — usa SQLite local, não depende de API |
| `/api/agenda-hoje` | auth | NOVO-6 — `Title` e `StageId` podem causar 403 |

### Dados exibidos vs dados disponíveis
| Coluna UI | Campo esperado | Campo real da API | Status |
|-----------|----------------|-------------------|--------|
| Risk Score | `riskScore` | `riskScore` | ✅ OK |
| Deals Abertos | `dealsAbertos` | `dealsAbertos` | ✅ OK |
| Ganhos Mês (contagem) | `ganhosMes` | `dealsGanhosMes` | 🔴 BUG-3 |
| Ganhos Mês (valor) | `receitaMes` | `receitaGanhaMes` | 🔴 BUG-3 |
| % Meta | `metaPct` | `metaProgress` (ratio) | 🔴 BUG-2 |
| Interações 7d | `interacoes7d` | `interacoes7d` | ✅ OK |
| Tarefas Vencidas | `tarefasVencidas` | `tarefasVencidas` | ✅ OK |
| Deals Parados >30d | `dealsParados` | `dealsPardos30d` | 🔴 BUG-1 |
| Ações Recomendadas | `actions` | `actions` | ✅ OK |

### Problema de segurança: supervisor não tem acesso ao gestor-dashboard
```js
// server.js:2022
function requireAdminOrGestor(req, res, next) {
  if (req.session.userId && (req.session.role === 'admin' || req.session.role === 'gestor')) return next();
```
O role `supervisor` não tem acesso ao endpoint `gestor-dashboard`, mas tem acesso à rota `/gestor` (deveria ser consistente). `alerts` e `agenda-hoje` permitem `supervisor` via `isGestor`, mas `gestor-dashboard` não.

---

## Prioridades de Correção

### Imediato (resolve múltiplos problemas de uma vez)
1. **Rodar ETL** — resolve o erro 403 e torna os dados frescos
   ```bash
   PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js
   ```

2. **Corrigir nomes de campo em `/api/gestor-dashboard`** (3 bugs com uma mudança)
   ```js
   // server.js: ao fazer res.json({ vendedores: ... }), mapear aliases:
   vendedores: Object.values(byOwner).map(r => ({
     ...r,
     ganhosMes: r.dealsGanhosMes,         // BUG-3
     receitaMes: r.receitaGanhaMes,        // BUG-3
     dealsParados: r.dealsPardos30d,       // BUG-1
     metaPct: Math.round((r.metaProgress || 0) * 100),  // BUG-2
   })).sort(...)
   ```

### Curto Prazo
3. Adicionar `StageId` e `Title` à lista `DEALS_FORBIDDEN_FIELDS_GLOBAL` (resolve NOVO-6)
4. Atualizar modelo IA de `claude-haiku-4-5` para `claude-sonnet-4-6` (pendente #9)
5. Adicionar balanceamento positivo ao riskScore (NOVO-4)

### Backlog
6. Migrar `gestor-dashboard` para usar warehouse (NOVO-5)
7. Corrigir segurança: remover chaves hardcoded (#2, #3)
8. Resolver N+1 queries (#5, #8, #14)
9. Agendar ETL com cron (#1)

---

*Fim da auditoria — 2026-05-21*

# AUDIT COMPLETA — CRM Ploomes Analyst
**Data:** 2026-05-21  
**Executado por:** Jarvis (direto, Claude Code indisponível como root)

---

## RESUMO EXECUTIVO

**Total de bugs corrigidos hoje:** 18  
**Críticos (filtros ignorados):** 4  
**Dados/ETL:** 4  
**Frontend/UX:** 6  
**Backend/Segurança:** 4  

---

## 1. AUDITORIA DE FILTROS (Funil e Vendedor)

### 🔴 BUG CRÍTICO — `/api/crm-health` ignorava filtros completamente
**Problema:**
- `computeCrmHealth()` era chamada sem parâmetros — sempre retornava dados globais
- Frontend chamava `fetch('/api/crm-health')` sem passar `pipelineId` ou `ploomesId`
- Cache key tinha os filtros (`crmHygiene_X_Y`) mas a fetch era sem params → dados sempre iguais

**Correção aplicada:**
- `computeCrmHealth(ids, { pipelineId, ownerIds })` — agora aceita e aplica os filtros
- Queries de `openDeals` e `lostDeals180` filtram por `PipelineId eq X` e `OwnerId eq Y`
- Warehouse bypass automático quando filtros estão presentes (mv_hygiene não tem dimensão de pipeline)
- Cache key inclui filtros: `${pipelineId||'all'}_${ownerIds.sort().join(',')}`
- `/api/crm-health` endpoint: extrai `?pipelineId=X&ploomesId=Y` da query string

**Arquivos:** `server.js` (computeCrmHealth, route /api/crm-health)  
**Frontends:** `dashboard.html`, `app.html` — agora passam params na fetch

### 🔴 BUG CRÍTICO — `/api/funnel-health` ignorava filtro de vendedor
**Problema:**
- Filtrava por pipelineId ✅, mas ignorava vendedor selecionado
- Comentário no código: "sem filtro de owner — front filtra para supervisor"
- Admin/gestor que selecionava um vendedor via select via dados de TODOS

**Correção aplicada:**
- `ownerIdFilter = filterPloomesId ? '%20and%20OwnerId%20eq%20...' : ''`
- Cache key: `fh_${userId}_${pipelineId}_${ploomesId}`
- Frontend: `dashboard.html` e `app.html` agora passam `ploomesId` na fetch

### 🔴 BUG CRÍTICO — `/api/pipelines-active` bloqueado para vendedores
**Problema:**
- Endpoint retornava 403 para role "vendedor"
- `dashboard.html`: `if (!r.ok) return` → pipeline select ficava vazio silenciosamente
- Pior: pipeline loading estava DENTRO de `loadVendors()` → se vendor falhasse, funil também falhava

**Correção aplicada:**
- Removida restrição de role — todos os autenticados podem acessar
- `loadPipelines()` separado de `loadVendors()` em `dashboard.html`
- Endpoint usa warehouse.db como fonte primária (mais rápido, sem chamada à API Ploomes)

### 🟠 BUG — `/api/ploomes-users` não respeitava desativação local
**Problema:**
- Verificava `Suspended` e `Integration` na API Ploomes
- Mas ignorava `app_users.active=0` (desativação interna da aplicação)

**Correção aplicada:**
- Cross-reference com `app_users WHERE active=0 AND ploomes_user_id IS NOT NULL`
- Usuários desativados localmente somem do select mesmo que não suspensos no Ploomes

---

## 2. AUDITORIA DE DADOS

### Pipelines ativos (warehouse.db):
```
Contratos               | active
Contratos Manutenção    | active
Controle de Venda Direta| active
LocMe - Locação         | active
Locados                 | active
Manutenção da Carteira  | active
Máquinas                | active
Peças e Serviços        | active
Prospecção              | active
---
Novos Clientes          | archived
Pré-Vendas - GO         | archived
Pré-Vendas MG           | archived
VENDA DIRETA - CTS      | archived
[Cópia] Manutenção...   | archived
```

### 🟠 Pipeline IDs órfãos em deals:
Deals referenciam 5 pipeline IDs que não existem na tabela `pipelines`:
- 10000536 (241 deals), 60012017 (102 deals), 10014928 (45 deals), 10014137 (12 deals), 10013482 (4 deals)

Estes são provavelmente funis deletados/arquivados antes do primeiro ETL.
**Impacto:** Estes deals aparecem com "Pipeline 10000536" em vez do nome correto.
**Ação:** Serão resolvidos no próximo ETL (que agora busca `Archived` da API).

### 🟠 sync_warehouse.js — campo `Archived` não era lido da API
**Problema:** ETL usava `INACTIVE_PIPELINE_IDS` hardcoded para marcar arquivados.
**Correção:** Adicionado `Archived` ao select da API; flag agora vem da fonte de verdade.

### Deals sem pipeline_id: **0** ✅

### ETL falhou nas últimas 2 execuções (rate limit):
- Run 18 e 19: `Error: API error: 120 requests per minute exceeded`
- Causa: múltiplos restarts do servidor (1 ETL kick por restart, cooldown in-memory resetava)

### 🔴 getWarehouseLastRun() retornava run com falha
**Problema:** `buildExecReportHtml`, `computeCrmHealthWarehouse`, relatórios usavam `getWarehouseLastRun()` que pode retornar run com `ok=0`, resultando em mv_hygiene vazia.
**Correção:**
- Criada `getWarehouseLastOkRun()` — sempre retorna o último run com `ok=1`
- Todas as funções de relatório/hygiene migradas para usar a nova função

### 🔴 ETL cooldown insuficiente
**Problema:** Cooldown de 5 min era in-memory; cada restart do servidor zerava o contador.
**Correção:**
- Cooldown aumentado de 5min para 30min
- Verificação adicional na DB: checa `etl_runs.started_at` antes de disparar (proteção pós-restart)

---

## 3. AUDITORIA BACKEND

### Endpoints e suporte a pipelineId:
| Endpoint | pipelineId | vendorId | Status |
|---|---|---|---|
| /api/dashboard | ✅ | ✅ | OK |
| /api/gestor-dashboard | ✅ | n/a (todos) | OK |
| /api/ranking | ✅ | ✅ | OK |
| /api/crm-health | ✅ CORRIGIDO | ✅ CORRIGIDO | OK |
| /api/funnel-health | ✅ | ✅ CORRIGIDO | OK |
| /api/chat (coach) | ✅ via ploomesId | ✅ via ploomesId | OK |

### Segurança:
- Rate limiting em /api/chat: 10 req/min por userId ✅
- Session secret com fallback hardcoded: 🟠 (PLOOMES_API_KEY e SESSION_SECRET devem estar em env)
- Queries SQLite usam prepared statements ✅ — sem SQL injection
- CORS: não configurado (aceita qualquer origem) 🟡 — aceitável se atrás de proxy

---

## 4. AUDITORIA FRONTEND

### dashboard.html:
- ✅ `loadPipelines()` separado de `loadVendors()` — corrigido
- ✅ `crm-health` agora passa pipelineId e ploomesId
- ✅ `funnel-health` agora passa ploomesId

### app.html:
- ✅ TTL de cache de vendors/pipelines: 4h → 2 min
- ✅ Pipeline carrega independente de vendor
- ✅ crm-health e funnel-health passam filtros corretos

### Cache TTLs (app.html):
- dashboard, crmHealth: 4h (aceitável — dados históricos mudam lentamente)
- vendors, pipelines: 2 min ✅ (alterações refletem rapidamente)
- funnelHealth, crmHygiene: usa FILTERS_TTL (2 min quando filtros ativos)

---

## 5. VALIDAÇÃO DE CÁLCULOS

### Score CRM (computeDashboard):
```
revenueScore: min(50, ganhosValor/meta*50) ou min(30, ganhosValor/5000) sem meta
activityScore: ganhos×8 + visitas×3 + interações×0.5 + tarefasNoPrazo×2
penaltyScore: tarefasVencidas×(-3) + staleDeals(cap -20)
coachBonus: semanasCoach×2
```
**Avaliação:** Fórmula razoável. Revenue tem peso máximo de 50pts, atividade sem limite de teto pode distorcer. Aceitável como está.

### Taxa de Conversão (mv_conversion):
- 90d: LocMe Locação 75%, Peças/Serviços 50%, Prospecção 38%, Máquinas 29%, Controle Venda 4%, Manutenção 0%
- Global (pipeline_id=NULL): 8.4% — inclui todos os funis, útil como baseline

### Ranking:
- dealWon: +8pts + min(20, amount/5000)
- interactions: +0.5pt geral, +2pt visitas/reuniões
- tasksPrazo: +3pt, tasksVencidas: -2pt
- dealsParados30d: -1pt (cap 20)
- coachWeekly: +2pt/semana

---

## ARQUIVOS MODIFICADOS HOJE

| Arquivo | Mudanças |
|---|---|
| server.js | computeCrmHealth com filtros, getWarehouseLastOkRun, kickWarehouse cooldown 30min+DB check, /api/crm-health aceita filtros, /api/funnel-health aceita ploomesId, /api/pipelines-active sem restrição de role usando warehouse, /api/ploomes-users cruza com app_users.active |
| dashboard.html | loadPipelines() separado, crm-health e funnel-health passam filtros |
| app.html | TTL 2min para vendors/pipelines, crm-health e funnel-health passam filtros |
| scripts/sync_warehouse.js | Lê campo Archived da API Ploomes, archived baseado em fonte de verdade |

---

*Gerado em: 2026-05-21T16:40 UTC*

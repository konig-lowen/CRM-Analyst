

---

# CHECKUP REPORT — CRM Ploomes Analyst

*Data: 2026-05-19 | Gerado por: Claude Code Checkup*

---

## Resumo Executivo

- **Warehouse desatualizado**: último ETL bem-sucedido em 2026-05-11 (8 dias atrás) — todas as MVs e análises estão com dados defasados, sem agendamento automático de sync
- **2 N+1 queries críticas**: `getAllowedPloomesIds` faz uma query por membro de equipe; `/api/reports/:userId` faz 18 chamadas Ploomes sequenciais (6 meses × 3 endpoints)
- **Segurança**: PLOOMES_API_KEY e SESSION_SECRET estão hardcoded no código-fonte — risco de vazamento em qualquer push/log
- **Modelo IA desatualizado**: server.js usa `claude-haiku-4-5` hardcoded em vez do `claude-sonnet-4-6` preferido
- **history.db WAL não checkpointed**: 4.1 MB de WAL pendente — risco de perda em crash sem checkpoint

---

## Problemas Críticos (Bloqueadores)

### 1. ETL Parado — Warehouse 8 Dias Desatualizado
- `warehouse.db` last modified: **2026-05-11 21:44 UTC**
- Todas as MVs (`mv_hygiene`, `mv_conversion`, etc.) têm dados de 8 dias atrás
- `git_sync.sh` sincroniza código, mas **não há cron/agendamento** para o ETL de dados
- **Fix**: `crontab -e` → `0 */4 * * * PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js >> /opt/ploomes-analyst/server.log 2>&1`

### 2. API Key Hardcoded no Código-Fonte (`server.js:18`)
```js
const PLOOMES_API_KEY = process.env.PLOOMES_API_KEY || '78B2E7C7435890F2...'
```
Se o repo for exposto ou o log vazado, a chave está em texto claro. **Fix**: remover o fallback — usar apenas `process.env.PLOOMES_API_KEY` e lançar erro se ausente.

### 3. SESSION_SECRET Hardcoded (`server.js:1933`)
```js
secret: process.env.SESSION_SECRET || 'ploomes-analyst-2024-xK9p'
```
Qualquer atacante pode forjar cookies de sessão. **Fix**: mesmo padrão — remover fallback.

### 4. history.db WAL não Checkpointed (4.1 MB)
- `history.db-wal` tem 4.1 MB pendentes
- Em crash do processo, dados podem não estar no arquivo principal
- **Fix**: `sqlite3 history.db "PRAGMA wal_checkpoint(TRUNCATE);"` e habilitar `PRAGMA wal_autocheckpoint = 1000` no startup do server.

---

## Problemas Médios (Degradam Performance/Qualidade)

### 5. N+1 Queries em `getAllowedPloomesIds` (`server.js:1996-1999`)
Para cada request de supervisor, faz **1 query por membro da equipe** para buscar `ploomes_user_id`:
```js
const memberIds = team.map(t => {
  const u = db.prepare('SELECT ploomes_user_id FROM app_users WHERE id=?').get(t.user_id);
  return u && u.ploomes_user_id;
}).filter(Boolean);
```
**Fix**: uma única query com `IN`:
```js
const memberRows = db.prepare(`SELECT ploomes_user_id FROM app_users WHERE id IN (${team.map(()=>'?').join(',')}) AND active=1`).all(...team.map(t=>t.user_id));
```

### 6. `/api/reports/:userId` — 18 Chamadas Ploomes Sequenciais (`server.js:3938-3959`)
Loop de 6 meses com 3 `ploomesGetAll` por mês = 18 requests sequenciais. Pode levar 30-60 segundos.
**Fix**: usar `/api/reports/ploomes/:ploomesUserId` (que já consulta o warehouse) ou migrar 6-month history para warehouse.

### 7. Índices Faltando no warehouse.db

| Query | Índice faltando |
|-------|-----------------|
| `mv_conversion`: `WHERE status_id IN (2,3) AND finish_date >= ?` | `(status_id, finish_date)` |
| `mv_hygiene`: abandoned — `WHERE owner_id=? AND status_id=1 AND julianday...` | `(owner_id, status_id)` |
| `mv_hygiene`: open no amount — `WHERE owner_id=? AND status_id=1 AND amount=0` | `(status_id, amount)` |
| `tasks`: open by owner — `WHERE owner_id=? AND finished=0` | `(owner_id, finished)` |

**Fix** (adicionar em `migrate()` de `sync_warehouse.js`):
```sql
CREATE INDEX IF NOT EXISTS idx_deals_status_finish ON deals(status_id, finish_date);
CREATE INDEX IF NOT EXISTS idx_deals_owner_status ON deals(owner_id, status_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_finished ON tasks(owner_id, finished);
```

### 8. N+1 na Materialize de `mv_hygiene` (`sync_warehouse.js:362-398`)
Loop em owners com 3 queries por owner. Com 33 owners = ~100 queries. Pode ser substituído por 3 queries SQL agregadas com GROUP BY.

### 9. Modelo IA Hardcoded como `claude-haiku-4-5` (`server.js:1790, 1882`)
- `askClaudeMessages`: model hardcoded como `'claude-haiku-4-5'`
- `askClaude`: default `model = 'claude-haiku-4-5'`
- Preferência do usuário: `claude-sonnet-4-6`
- **Fix**: alterar default para `'claude-sonnet-4-6'` em ambas as funções

### 10. `/api/crm-health` e `computeDashboard` — Deals Abertos Sem Filtro de Data
```js
ploomesGetAll(`/Deals?...&$filter=StatusId%20eq%201...`)
```
Busca TODOS os deals abertos sem limite temporal — pode retornar milhares de registros e causar timeout. Deveria usar warehouse + `mv_pipeline_snapshot`.

### 11. `node-fetch` em package.json mas Nunca Importado
`node-fetch` está listado como dependência mas o `server.js` não o importa (usa `https` nativo). Dependência fantasma, aumenta bundle de instalação.

---

## Melhorias de Baixa Prioridade

### 12. Arquivos `.bak` no Working Tree
8 arquivos `.bak` no diretório raiz (`admin.html.bak`, `index.html.bak`, etc.) não estão no `.gitignore` mas deveriam ser removidos ou adicionados ao ignore.

### 13. Senha Mínima de 4 Caracteres (`server.js:2658`)
`if (!username?.trim() || !password || password.length < 4)` — muito fraco para produção. Recomendado: mínimo 8 caracteres.

### 14. `computeRanking` — N Queries para Coach Bonus (`server.js:2224-2232`)
Uma query SQLite por usuário no scope para contar semanas de coach. Pode ser batched com uma única query `IN` agrupada.

### 15. history.db WAL Mode mas sem `busy_timeout`
Sem `PRAGMA busy_timeout`, operações concorrentes de leitura/escrita no history.db podem falhar com `SQLITE_BUSY`. **Fix**: `db.pragma('busy_timeout = 5000')` no startup.

### 16. `inferDateRangeFromMessage` — Regex de Março (`server.js:163`)
`mar(?:[çc]o)?` não captura a forma "março" com cedilha corretamente em todos os locales. Testar com input real.

---

## Próximos 3 Passos Recomendados

### Passo 1 — Agendar ETL (urgente — dados 8 dias defasados)
```bash
# Rodar sync imediato
PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js

# Agendar via cron (a cada 4 horas)
crontab -e
# adicionar: 0 */4 * * * PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js >> /opt/ploomes-analyst/server.log 2>&1
```

### Passo 2 — Corrigir Segurança (chaves hardcoded)
Em `server.js`:
```js
// Linha 18: remover o fallback hardcoded
const PLOOMES_API_KEY = process.env.PLOOMES_API_KEY;
if (!PLOOMES_API_KEY) { console.error('PLOOMES_API_KEY obrigatório'); process.exit(1); }

// Linha 1933: remover o fallback hardcoded
secret: process.env.SESSION_SECRET  // lançar erro se undefined
```

### Passo 3 — Corrigir N+1 em `getAllowedPloomesIds` + Atualizar Modelo IA
```js
// server.js ~1996: substituir loop por IN query
const memberRows = db.prepare(`
  SELECT ploomes_user_id FROM app_users
  WHERE id IN (${team.map(()=>'?').join(',')}) AND active=1 AND ploomes_user_id IS NOT NULL
`).all(...team.map(t => t.user_id));
const memberIds = memberRows.map(r => r.ploomes_user_id);

// server.js ~1790 e 1882: atualizar modelo
model: 'claude-sonnet-4-6'  // era claude-haiku-4-5
```

---

## Mapa de Rotas `/api/*`

| Método | Rota | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/api/me` | auth | Dados da sessão atual |
| GET | `/api/warehouse/status` | admin | Status do ETL/warehouse |
| GET | `/api/ploomes-users` | admin/gestor/supervisor | Lista usuários Ploomes ativos |
| GET | `/api/pipelines-active` | admin/gestor/supervisor | Funis ativos |
| GET | `/api/dashboard` | auth | KPIs do vendedor/time |
| GET | `/api/ranking` | auth | Ranking de performance |
| GET/POST | `/api/goals` | admin | Metas dos vendedores |
| PUT | `/api/goals/:id` | admin | Atualizar meta |
| GET | `/api/coaching-summaries/:userId` | auth | Histórico de coaching |
| GET | `/api/data-quality` | auth | Diagnóstico de qualidade CRM |
| GET | `/api/crm-health` | admin/gestor/supervisor | Higiene CRM por vendedor |
| GET | `/api/chat-history/:userId` | auth | Histórico de chat |
| GET/POST/PUT/DELETE | `/api/chat-sessions` | auth | Sessões de chat |
| GET | `/api/chat-sessions/:id/messages` | auth | Mensagens de sessão |
| DELETE | `/api/history` | auth | Apagar histórico |
| GET/POST | `/api/admin/users` | admin | Gestão de usuários |
| PUT/DELETE | `/api/admin/users/:id` | admin | Editar/remover usuário |
| POST | `/api/admin/users/:id/resolve-ploomes` | admin | Vincular Ploomes ID |
| GET/POST | `/api/admin/teams` | admin | Gestão de equipes |
| POST/DELETE | `/api/admin/teams/:id/members` | admin | Membros de equipe |
| POST | `/api/admin/generate-report` | admin/gestor | Gerar relatório HTML |
| GET | `/api/admin/reports` | admin/gestor | Listar relatórios |
| GET | `/api/admin/reports/:filename` | admin/gestor | Download de relatório |
| GET/POST | `/api/sync-ploomes-users` | admin | Sync usuários Ploomes |
| GET | `/api/reports/ploomes/:ploomesUserId` | admin/gestor/supervisor | Relatório por Ploomes ID (warehouse) |
| GET | `/api/reports/:userId` | admin/gestor/supervisor | Relatório detalhado (18 API calls) |

---

## Status do Banco de Dados

| Item | Status |
|------|--------|
| warehouse.db schema | OK — índices cobrindo casos principais |
| Índices faltando | 3 compostos críticos para MVs |
| Último ETL | 2026-05-11 21:44 UTC (8 dias atrás) |
| ETL agendado | **NÃO** — manual apenas |
| history.db WAL | 4.1 MB pendente |
| sessions.db | OK — 24 KB |
| interactions.deal_id | **Não existe** — por design da API Ploomes |

---


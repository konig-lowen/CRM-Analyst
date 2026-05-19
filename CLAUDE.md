# CLAUDE.md — CRM Ploomes Analyst

## Stack
- **Backend**: Node.js / Express (`server.js`)
- **Banco local**: SQLite via `better-sqlite3`
  - `warehouse.db` — dados sincronizados da API Ploomes (deals, users, pipelines, MVs)
  - `history.db` — chat sessions, coaching, app_users, metas
  - `sessions.db` — express-session
- **IA**: Anthropic SDK (`@anthropic-ai/sdk`) — usar **claude-sonnet-4-6** (não haiku, não opus)
- **Frontend**: HTML puro (app.html, coach.html, dashboard.html, ranking.html, admin.html)

## Regras de Negócio (obrigatórias)
- **Nunca inventar dados**: toda análise vem via fetch da API Ploomes ou warehouse.db
- Se não há `fetchData` no contexto → resposta deve admitir falha
- Vendor selector: fixo no topo do chat, apenas admin/gestor/supervisor podem trocar
- Modelo IA padrão: **claude-sonnet-4-6** (economiza tokens vs opus, melhor qualidade vs haiku)

## Skills disponíveis (OpenClaw)
- `~/.openclaw/workspace/skills/frontend-design-pro/` — revisão e polimento de UI/frontend
  - Triggers: /audit, /polish, /critique, /colorize, /animate
  - Usar para reviews de app.html, coach.html, dashboard.html etc.
- `~/.openclaw/workspace/skills/openclaw-token-optimizer/` — otimização de consumo de tokens
  - Scripts: context_optimizer.py, model_router.py, heartbeat_optimizer.py, token_tracker.py
  - Usar antes de mudanças que afetam quantidade de chamadas de IA

## Problemas Conhecidos (ver CHECKUP_REPORT.md para detalhes)
1. ETL sem agendamento automático — warehouse pode ficar desatualizado
2. API key e session secret com fallback hardcoded em server.js
3. N+1 query em `getAllowedPloomesIds`
4. `/api/reports/:userId` faz 18 chamadas Ploomes sequenciais

## Banco de Dados — Estrutura Resumida
```
warehouse.db:
  deals (3k+ rows) — id, owner_id, pipeline_id, stage_id, status_id, amount, create/finish_date
  interactions (11k rows) — id, creator_id, date, type_id  [sem FK para deals — design da API]
  tasks (822 rows) — by owner
  mv_pipeline_snapshot, mv_conversion, mv_loss_reasons, mv_hygiene — atualizadas no ETL

history.db:
  app_users, teams, team_members — gestão interna
  chat_sessions, messages — histórico de conversas
  coaching_summaries, predictions, goals — coaching AI
  fetch_cache — cache de chamadas Ploomes
```

## ETL / Sync
```bash
# Rodar sync manual
PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js

# Agendar (recomendado: a cada 4h)
# crontab: 0 */4 * * * PLOOMES_API_KEY=xxx node /opt/ploomes-analyst/scripts/sync_warehouse.js
```

## Variáveis de Ambiente Necessárias
```
PLOOMES_API_KEY=   # obrigatório — chave da API Ploomes
SESSION_SECRET=    # obrigatório — segredo para cookies de sessão
PORT=3001          # opcional, default 3001
ANTHROPIC_API_KEY= # obrigatório — para chamadas de IA
```

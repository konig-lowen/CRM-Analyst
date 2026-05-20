# Fase 0 — Estrutura do Projeto

**Data:** 2026-05-20T19:56 UTC

## Arquivos JS

```
-rwx--x--x 1 root root  21K May 11 21:41 ./scripts/sync_warehouse.js
-rw-r--r-- 1 root root 195K May 18 18:46 ./server.js
```

## Arquivos HTML

```
./dashboard.html
./app.html
./coach.html
./reports.html
./admin.html
./login.html
./index.html
./backups/exec-report-2026-05-11-run4-1778536230770.html
./backups/exec-report-2026-05-11-run4-1778536224043.html
./backups/exec-report-2026-05-11-run4-1778536230947.html
./ranking.html
```

## Bancos de Dados

```
./history.db
./warehouse.db
./sessions.db
```

## Dependências (package.json)

```
DEPS: ['@anthropic-ai/sdk', 'better-sqlite3', 'better-sqlite3-session-store', 'express', 'express-session', 'node-fetch']
```

## Observações

- `server.js` é monolítico com **195KB** — alto risco de violações de SRP
- 3 bancos SQLite separados: history, warehouse, sessions
- Sem TypeScript, sem ORM, sem framework de DI
- Apenas 2 arquivos JS funcionais (server.js + sync_warehouse.js)
- 8 HTMLs servidos diretamente — possível ausência de bundler/build

# Implementação: Filtro de Pipeline (pipelineId)

**Data:** 2026-05-21  
**Commit:** feat: filtro de pipeline em gestor-dashboard e ranking

## O que foi feito

### Backend — `server.js`

#### `/api/gestor-dashboard`
- Extrai `pipelineId` do query string: `req.query.pipelineId ? Number(req.query.pipelineId) : null`
- Cria `pipelineFilter = pipelineId ? '%20and%20PipelineId%20eq%20{N}' : ''`
- Aplica `pipelineFilter` nas queries de:
  - `dealsOpen` (StatusId eq 1)
  - `dealsWonMonth` (StatusId eq 2)
  - `dealsLostMonth` (StatusId eq 3)
- `InteractionRecords` e `Tasks` **não** recebem filtro de pipeline — API Ploomes não suporta `PipelineId` nessas entidades
- Quando `pipelineId` fornecido, `activeDeals` usa `dealsOpen` direto (sem filtrar ARCHIVED), pois o funil já está fixado

#### `computeRanking({ ..., pipelineId })`
- Aceita `pipelineId` no destructuring de parâmetros
- Cria `pipelineFilter` internamente
- Aplica em `dealsWon` e `dealsOpen`
- `interactions`, `tasksFinished`, `tasksOpen` **não** filtrados por pipeline

#### `/api/ranking`
- Extrai `pipelineId` do query string e passa para `computeRanking`

### Frontend

#### `gestor.html`
- Adicionado `<select id="pipelineSelectGestor">` no header
- Variável `selectedPipelineId = null`
- `DOMContentLoaded` carrega `/api/pipelines-active` e popula o seletor
- `loadAll()` inclui `?pipelineId=N` na fetch do `gestor-dashboard` quando selecionado

#### `ranking.html`
- Adicionado `<select id="pipelineSelectRanking">` na barra de filtros
- Variável `selectedPipelineId = null`
- `init()` carrega `/api/pipelines-active` e popula o seletor
- `loadRanking()` inclui `pipelineId` nos params da fetch e no cache key
- `forceRefresh()` limpa o cache do ranking quando pipeline muda

## Restrições conhecidas
- `InteractionRecords` e `Tasks` na API Ploomes não aceitam filtro `PipelineId` — comportamento mantido sem filtro nessas entidades
- Pontuação no ranking é baseada em deals filtrados por pipeline + interações/tarefas globais do usuário

## Testes realizados
- `GET /api/gestor-dashboard?pipelineId=10014103` → 200, `vendedores: 9`
- `GET /api/gestor-dashboard?pipelineId=60000081` → 200, `vendedores: 9, dealsAbertos: 6`
- `GET /api/gestor-dashboard` (sem filtro) → 200 (regressão OK)
- `GET /api/ranking?pipelineId=10014103` → 200, estrutura correta
- `node --check server.js` → SYNTAX OK
- `systemctl is-active ploomes-analyst` → active

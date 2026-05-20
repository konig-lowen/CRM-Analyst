# Fase 1 — Auditoria Backend

**Data:** 2026-05-20T19:56 UTC  
**Arquivo auditado:** server.js (4031 linhas, 195KB)  
**Executada por:** Subagente (direto, sem Claude Code — root não suportado)

---

## Sumário Executivo

O `server.js` é um **monólito de 4031 linhas** com múltiplas violações críticas de segurança, memory leaks estruturais, race conditions e ausência de observabilidade. Os problemas mais graves são a API key hard-coded no código-fonte, ausência de limite de taxa por usuário no chat, e um `computeSalesIndicatorsWarehouse` com recursão infinita em produção.

---

## Problemas por Dimensão

---

**[🔴 CRÍTICO] API Key Ploomes Hard-coded no Código-fonte**
- Descrição: Linha 19 — `const PLOOMES_API_KEY = process.env.PLOOMES_API_KEY || '78B2E7C7435890F250B3E867B0496F2B0C3270D67BBC3A03761A567A62468F5D8647146C209BF0879367FA0BFB6B9C4056D7D882524E106AD5561D8AB987F58B'` — chave de 128 chars em fallback literal no código.
- Impacto real: Qualquer commit no git, log de erro, stack trace ou acesso ao código expõe a chave completa. Se o repositório for privado hoje, basta um leak ou um `git log` vazar.
- Risco futuro: Rotação de chave silenciosa pelo Ploomes não é detectada. Chave fica permanentemente no histórico git.
- Solução técnica: Remover fallback hard-coded. Lançar erro na inicialização se `process.env.PLOOMES_API_KEY` não estiver definida. Usar `.env` com `.gitignore` ou secret manager.

---

**[🔴 CRÍTICO] Session Secret Hard-coded**
- Descrição: Linha ~1950 — `secret: process.env.SESSION_SECRET || 'ploomes-analyst-2024-xK9p'` — secret de sessão fixo e previsível.
- Impacto real: Qualquer pessoa com o código pode forjar cookies de sessão válidos para qualquer usuário, incluindo admin.
- Risco futuro: Comprometimento total da autenticação se o servidor for acessado por qualquer ator externo.
- Solução técnica: Remover fallback. Gerar secret aleatório com `crypto.randomBytes(64).toString('hex')` na inicialização e exigir variável de ambiente.

---

**[🔴 CRÍTICO] Recursão Infinita em `computeSalesIndicatorsWarehouse`**
- Descrição: Linhas ~930–940 — `computeSalesIndicatorsWarehouse` (a função warehouse) chama a si mesma dentro do bloco `try`:
  ```js
  function computeSalesIndicatorsWarehouse(ploomesIds, periodDays) {
    ...
    try {
      if (isWarehouseFresh()) {
        const wh = computeSalesIndicatorsWarehouse(ploomesIds, periodDays); // RECURSÃO INFINITA
        if (wh && !wh.error) return wh;
      } else {
        kickWarehouseSyncBackground(...)
      }
    }
  ```
  Esse código é identico ao que existe em `computeSalesIndicators` (a versão async), e foi copiado erroneamente na versão síncrona.
- Impacto real: Qualquer chamada a `computeSalesIndicatorsWarehouse` resulta em stack overflow, crash do processo Node.js ou timeout de request.
- Risco futuro: Cada request de chat injeta indicadores via `computeSalesIndicators`, que tenta warehouse first — derruba o servidor em produção assim que o warehouse ficar fresh.
- Solução técnica: Remover o bloco `try { if (isWarehouseFresh()) { const wh = computeSalesIndicatorsWarehouse... } }` de dentro da própria função. A função `computeSalesIndicatorsWarehouse` não deve chamar a si mesma.

---

**[🔴 CRÍTICO] Ausência de Rate Limiting no Endpoint `/api/chat` e `/api/chat/coach`**
- Descrição: Os dois endpoints de chat executam até 5 rounds de fetches Ploomes + chamadas Claude/OpenAI cada. Sem nenhum rate limiter (nem por sessão, nem por IP, nem por userId).
- Impacto real: Um único usuário pode criar dezenas de requests concorrentes, consumir todo o limite de concorrência da Ploomes API (max 4 conforme `ploomesGetOnce`) e esgotar créditos Claude/OpenAI em minutos.
- Risco futuro: Ataque acidental (loop no frontend) ou intencional pode derrubar o serviço e gerar custo ilimitado.
- Solução técnica: Adicionar middleware `express-rate-limit` por `userId` (ex: 10 req/min no chat). Adicionar timeout global por request de chat (ex: 60s com `AbortController`).

---

**[🔴 CRÍTICO] Endpoint `/api/data-quality` Sem Autenticação de Role**
- Descrição: Linha ~2590 — `app.get('/api/data-quality', requireAuth, ...)` — qualquer usuário autenticado (incluindo `vendedor`) acessa diagnóstico completo de qualidade de dados do CRM, incluindo volumes totais, percentuais de deals perdidos sem motivo, e estrutura do pipeline.
- Impacto real: Vendedor pode ver metadados de performance de colegas e do time completo.
- Risco futuro: Vazamento de dados estratégicos para usuários sem permissão.
- Solução técnica: Adicionar `requireAdmin` ou `requireAdminOrGestor` middleware. Ou filtrar o resultado por `getAllowedPloomesIds(req)` antes de retornar.

---

**[🔴 CRÍTICO] Memory Leak — `_ploomesCache` Map Sem Eviction**
- Descrição: Linha ~600 — `const _ploomesCache = new Map()` — cache em memória para respostas Ploomes com TTL de 60s, mas nunca é purgado além de consulta individual. `cacheSet` nunca limita o tamanho do Map.
- Impacto real: Em produção com múltiplos usuários fazendo queries distintas, o Map cresce indefinidamente. Cada URL única vira uma entrada permanente (até reiniciar o processo).
- Risco futuro: Degradação de memória ao longo de horas/dias. O processo Node.js pode ser killed pelo OS.
- Solução técnica: Implementar LRU com tamanho máximo (ex: 500 entradas) ou `setInterval` que purga entradas expiradas a cada 5 minutos.

---

**[🔴 CRÍTICO] Memory Leak — `dashboardCache` e `funnelHealthCache` Maps Sem Eviction**
- Descrição: Linhas ~2330 e ~2850 — `const dashboardCache = new Map()` e `const funnelHealthCache = new Map()` — caches por `cacheKey` (combinação userId + params). Chaves são criadas por cada combinação nova de parâmetros, jamais removidas.
- Impacto real: Cada combinação única de usuário + filtro vira uma entrada permanente no Map.
- Risco futuro: Acúmulo silencioso em servidores de longa duração.
- Solução técnica: Usar `setTimeout` ou `setInterval` para purgar entradas expiradas. Ou limitar tamanho do Map.

---

**[🟠 ALTO] Race Condition — `warehouseSyncInFlightAt` sem Mutex**
- Descrição: Função `kickWarehouseSyncBackground` usa `warehouseSyncInFlightAt` como debounce (5 min), mas a variável é lida e escrita sem lock:
  ```js
  if (warehouseSyncInFlightAt && (Date.now() - warehouseSyncInFlightAt) < 5 * 60 * 1000) return false;
  warehouseSyncInFlightAt = Date.now(); // não é atômico
  ```
- Impacto real: Em ambiente com requests concorrentes (Node.js é single-threaded, mas com await intercalado), múltiplas chamadas podem passar o check antes de qualquer uma setar o flag, spawando múltiplos processos de sync simultâneos.
- Risco futuro: Múltiplos writes concorrentes no `warehouse.db` SQLite, corrompendo dados do ETL.
- Solução técnica: Usar um `Promise` de lock (ex: flag `let syncPromise = null`) em vez de timestamp.

---

**[🟠 ALTO] `computeCrmHealth` Cache Global Compartilhado Entre Usuários**
- Descrição: Linhas ~1380–1395 — `crmHealthCache` e `crmHealthCacheAt` são variáveis de módulo. O cache não distingue qual usuário está pedindo. A função retorna os mesmos dados (com dados de todos os vendedores) para qualquer usuário que chame, independente de seu escopo (`getAllowedPloomesIds`).
- Impacto real: Um vendedor que chama `/api/crm-health` (ou indiretamente via chat) pode receber dados de saúde do time inteiro — mas `/api/crm-health` tem `requireAdmin`... O problema real é no chat: `computeCrmHealth()` é chamada sem escopo do usuário, e o resultado é injetado no contexto do chat de qualquer usuário logado.
- Risco futuro: Vazamento de higiene e performance de colegas para vendedores via contexto do chat.
- Solução técnica: Passar `effectivePloomesIds` para `computeCrmHealth` e filtrar o cache por escopo. Ou remover a injeção global de CRM health do contexto de chat de vendedores.

---

**[🟠 ALTO] `ploomesGetAll` Sem Retry e Sem Backoff**
- Descrição: Função `ploomesGetAll` (linha ~1800) faz paginação com `ploomesGetOnce` em loop. `ploomesGetOnce` tem timeout de 30s mas nenhum retry em caso de erro transitório (5xx, timeout, network).
- Impacto real: Um único timeout no meio de uma paginação de 50 páginas aborta toda a query e retorna erro ao usuário.
- Risco futuro: Instabilidade da Ploomes API se reflete diretamente em erros de usuário sem tentativa de recuperação.
- Solução técnica: Adicionar retry com backoff exponencial (3 tentativas, 1s/2s/4s) em `ploomesGetOnce`.

---

**[🟠 ALTO] Processo Síncrono Bloqueante — `db.exec()` com DDL na Inicialização**
- Descrição: Linhas ~280–360 — `db.exec(...)` executa CREATE TABLE, CREATE INDEX e múltiplos ALTER TABLE sincrônamente na inicialização do módulo, antes do servidor escutar conexões. Em banco grande, isso pode atrasar o startup.
- Impacto real: Em produção com history.db crescendo (histórico de mensagens), as operações DDL podem bloquear o event loop por segundos no startup.
- Risco futuro: Restart do processo (deploy, crash) causa janela de indisponibilidade proporcional ao tamanho do banco.
- Solução técnica: Mover DDL para script de migração separado executado antes do `app.listen`. Usar ferramenta de migração (ex: `better-sqlite3-migrations`).

---

**[🟠 ALTO] `loadDictionary` Chamado Concorrentemente Sem Deduplicação**
- Descrição: `loadDictionary` (linha ~1810) verifica `dictionaryLoadedAt` para cache de 30 min, mas não guarda uma Promise em flight. Se múltiplas requests chegarem simultaneamente quando o cache expirar, todas passam pelo check `if (dictionary && now - dictionaryLoadedAt < 30 * 60 * 1000)` ao mesmo tempo e disparam múltiplos fetches paralelos para a Ploomes API.
- Impacto real: 9 chamadas simultâneas à Ploomes API por cada "stampede" de cache. Pode disparar rate limit da Ploomes.
- Risco futuro: Falha em cascata no horário de pico.
- Solução técnica: Salvar a Promise de carregamento em uma variável e reutilizá-la: `if (dictionaryLoadingPromise) return dictionaryLoadingPromise;`

---

**[🟠 ALTO] Processos N+1 em `computeRanking` e `computeDashboard`**
- Descrição: `computeDashboard` e `computeRanking` fazem múltiplos `ploomesGetAll` em sequência ou parcialmente em paralelo. O problema está em `computeRanking` para coach bonus (linha ~2020):
  ```js
  for (const appId of scopeAppUserIds) {
    const w = db.prepare('SELECT ... FROM coaching_summaries WHERE user_id = ?').get(appId, ...)
  ```
  Uma query SQLite por vendedor em loop.
- Impacto real: Para 10 vendedores = 10 queries SQLite síncronas em série. Impacto baixo agora, mas padrão ruim.
- Risco futuro: Com dezenas de vendedores, latência cresce linearmente.
- Solução técnica: Substituir por uma query com `IN (...)`: `SELECT user_id, COUNT(DISTINCT strftime('%Y-%W', created_at)) as w FROM coaching_summaries WHERE user_id IN (?) AND created_at >= ? GROUP BY user_id`.

---

**[🟠 ALTO] `computeSalesIndicators` Duplica Lógica de `computeSalesIndicatorsWarehouse` com Bug**
- Descrição: A versão async `computeSalesIndicators` e a síncrona `computeSalesIndicatorsWarehouse` têm lógicas paralelas que podem divergir. Além disso, o bloco de cálculo de `conversionByPipeline` na versão async tem código morto (linhas ~1215–1230 calculam `conversionByPipeline` e depois imediatamente o redefinem como `convByPipe`):
  ```js
  const conversionByPipeline = {}; // calculado aqui
  ...
  const convByPipe = {}; // mesmo dado, recalculado 10 linhas depois, sobrescreve
  ```
- Impacto real: Código morto que confunde mantenedores e pode introduzir bugs em manutenções futuras.
- Risco futuro: Divergência entre resultados warehouse e API se lógicas evoluírem separadamente.
- Solução técnica: Unificar as duas funções (síncrona/async) em uma única com adaptador. Remover código morto de `conversionByPipeline`.

---

**[🟠 ALTO] Sem Limite de Tamanho para Mensagens no Chat — Tokens Ilimitados ao LLM**
- Descrição: O histórico de chat injetado no prompt usa `LIMIT 16` (linha ~3060), mas o `message` do usuário não tem limite e é concatenado com até 6 contextos grandes (`dataQualityContext`, `crmHealthContext`, `salesIndicatorsContext`, `fonteContext`, mapeamento de vendors, mapeamento de funis). O total pode facilmente exceder 50k tokens.
- Impacto real: Custo de API Claude/OpenAI por request pode ser muito alto. Além disso, prompts muito longos degradam a qualidade da resposta (lost-in-the-middle problem).
- Risco futuro: Um único request pode consumir equivalente a 10x o custo médio esperado.
- Solução técnica: Truncar o mapeamento de usuários/funis injetado (já tem muitos dados redundantes). Limitar o `salesIndicatorsContext` a top-N por relevância.

---

**[🟡 MÉDIO] Tratamento de Erro Silencioso em Múltiplos Lugares**
- Descrição: Múltiplos `try { ... } catch {}` vazios (sem log) em funções críticas:
  - `getWarehouseDb()` — silencia erro ao abrir warehouse.db
  - `resolveDataSource()` — bloco try/catch que silencia erro de data
  - Múltiplos blocos de injeção de contexto no chat — erros nos indicadores calculados são silenciados
- Impacto real: Falhas silenciosas são invisíveis. Se `warehouse.db` corromper, o sistema degradará silenciosamente para API sem nenhum alerta.
- Risco futuro: Diagnóstico de problemas em produção extremamente difícil.
- Solução técnica: Substituir `catch {}` por `catch (e) { console.warn('[contexto]', e.message) }` no mínimo. Para erros de warehouse, adicionar alerta explícito.

---

**[🟡 MÉDIO] `fetch_cache` Limpeza por Limite (200 entradas) Usa DELETE IN Sem Índice Otimizado**
- Descrição: `setCachedFetch` (linha ~430) — quando `count >= 200`, deleta as 20 entradas mais antigas com:
  ```sql
  DELETE FROM fetch_cache WHERE id IN (SELECT id FROM fetch_cache WHERE user_id=? AND chat_session_id=? ORDER BY created_at ASC LIMIT 20)
  ```
  SQLite pode não usar índice eficientemente em subquery com ORDER + LIMIT para DELETE.
- Impacto real: Em sessões com muitos fetches, essa query pode ser lenta.
- Risco futuro: Degradação de latência do endpoint de chat com histórico longo.
- Solução técnica: Usar `rowid` em vez de subquery, ou simplesmente manter um índice em `(user_id, chat_session_id, created_at)`.

---

**[🟡 MÉDIO] `ploomesGetAll` Aceita `maxRecords = 100000` como Safety Cap**
- Descrição: `ploomesFetchForModel` chama `ploomesGetAll(sumUrl, 100000)` para calcular `sumAmount` (linha ~700). 100k registros = 1000 requests paginadas de 100.
- Impacto real: Para queries de deals sem filtro preciso, pode disparar centenas de requests à Ploomes API em sequência.
- Risco futuro: Rate limit da Ploomes ou timeout de 30s em cada página = dezenas de minutos de bloqueio.
- Solução técnica: Reduzir safety cap para 5000. Documentar explicitamente o limite. Alertar o LLM quando `totalCount > 5000` para refinar filtros.

---

**[🟡 MÉDIO] `app/api/reports/:userId` Faz 6×3 = 18 Requests Ploomes em Série Parcial**
- Descrição: Linha ~3880 — loop de 6 meses com `Promise.all` de 3 queries cada. São 6 iterações em série (loop `for`), cada uma com 3 promises. Total: 18 requests HTTP à Ploomes para carregar um relatório.
- Impacto real: Com latência de 200ms/request, = 6×(3×200ms) = ~3.6s de latência mínima (sem contar processamento).
- Risco futuro: Timeout em clientes com conexão lenta. Risco de rate limit.
- Solução técnica: Migrar para warehouse (já existe `GET /api/reports/ploomes/:ploomesUserId` que usa warehouse). Deprecar `GET /api/reports/:userId`.

---

**[🟡 MÉDIO] Logs Insuficientes — Sem Request ID, Sem Duração, Sem Usuário**
- Descrição: Os logs existentes são `console.log('[fetch r1] ...')` e `console.error('[chat error]', e)`. Não há: request ID, duração do request, userId, quantidade de tokens consumidos por chamada LLM.
- Impacto real: Em produção, impossível correlacionar logs de um request específico. Impossível saber quanto cada usuário consome de LLM.
- Risco futuro: Debugging de problemas de produção requer releitura de logs sem contexto.
- Solução técnica: Adicionar middleware de logging com `req.id` (ex: `uuid`), duração, `userId` e status de resposta. Logar tokens consumidos por chamada Claude/OpenAI.

---

**[🟡 MÉDIO] `sanitizeDealSelectGlobal` Usa `new URL('https://dummy.local' + url)` em Toda Request**
- Descrição: Funções `sanitizeDealSelectGlobal`, `hasMandatoryDateFilter`, `upsertQueryParam` e `ploomesFetchForModel` criam objetos `URL` com `https://dummy.local` prefix em cada chamada. São chamadas múltiplas vezes por round de fetch.
- Impacto real: Overhead de parsing de URL desnecessário. Menor, mas padrão ruim.
- Risco futuro: Confunde debugging (URLs parecem reais nos stack traces).
- Solução técnica: Criar helper `parseRelativeUrl(path)` que encapsula o dummy host e reutiliza a lógica de forma clara.

---

**[🟢 BAIXO] Senha Padrão Hard-coded no Bootstrap**
- Descrição: Linha ~530 — `hashPassword('vetorv2024')` como senha padrão do admin `paulo` criada automaticamente se não há usuários.
- Impacto real: Qualquer novo deploy tem uma senha padrão conhecida até ser alterada manualmente.
- Risco futuro: Esquecimento de troca da senha padrão em novos ambientes.
- Solução técnica: Gerar senha aleatória no bootstrap e logar no console apenas uma vez: `console.log('[auth] Senha inicial admin:', geradaSenha)`. Forçar troca no primeiro login.

---

**[🟢 BAIXO] `requireAdmin` e `requireAdminOrGestor` São Funções Idênticas**
- Descrição: Linhas ~1960–1970 — ambas verificam `role === 'admin' || role === 'gestor'`. Código duplicado.
- Impacto real: Nenhum, exceto manutenção: alterar uma e esquecer a outra.
- Solução técnica: Remover `requireAdmin` e usar apenas `requireAdminOrGestor` em todo o código (ou vice-versa). Renomear para clareza.

---

**[🟢 BAIXO] Chat Session ID Não Validado como Pertencente ao Usuário Logado**
- Descrição: Em `POST /api/chat` e `POST /api/chat/coach`, o `chat_session_id` do body é usado diretamente para salvar mensagens sem verificar se essa sessão pertence ao `req.session.userId`.
- Impacto real: Um usuário pode enviar `chat_session_id` de outro usuário e salvar mensagens na sessão dele.
- Risco futuro: Poluição de histórico de chat de outros usuários (não é leitura de dados alheios, mas escrita).
- Solução técnica: Validar `SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?` antes de salvar mensagens.

---

## Resumo de Severidades

| Severidade | Quantidade |
|------------|-----------|
| 🔴 Crítico  | 7         |
| 🟠 Alto     | 7         |
| 🟡 Médio    | 5         |
| 🟢 Baixo    | 3         |
| **Total**   | **22**    |

## Top 3 Prioridades Imediatas

1. **Remover API key e session secret hard-coded** — risco de segurança imediato
2. **Corrigir recursão infinita em `computeSalesIndicatorsWarehouse`** — crash em produção garantido quando warehouse ficar fresh
3. **Adicionar rate limiting no `/api/chat`** — vetor de custo ilimitado e abuso

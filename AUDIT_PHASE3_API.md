# AUDIT — Fase 3: Integração API Ploomes
**Data:** 2026-05-20
**Arquivos analisados:** `server.js`, `scripts/sync_warehouse.js`

---

## Resumo Executivo

A integração com a API Ploomes é **somente leitura** (GET) — sem risco de escrita acidental. O código possui boas práticas de base (semáforo de concorrência, cache em memória, timeout de 30s), mas carece de mecanismos críticos de resiliência: **zero retry**, **zero proteção explícita a rate limit (429)**, **falhas silenciosas em múltiplos pontos**, e **ausência de sync agendado** (o warehouse é atualizado apenas por ação do usuário ou trigger colateral de request). Em produção, esses gaps podem resultar em dados desatualizados ou análises incorretas sem que o sistema reporte o problema.

---

## Problemas Identificados

---

**[🔴] Zero retry — toda falha de API é fatal e silenciosa para o usuário**
- **Descrição:** `ploomesGetOnce` (tanto em `server.js` quanto em `sync_warehouse.js`) faz uma única tentativa HTTP. Qualquer erro de rede, timeout ou resposta 5xx derruba a operação inteira sem retentativa. O erro é capturado por alguns callers com `catch(e) { return { error: e.message }; }` — mas em `computeDashboard`, `computeRanking` e `computeCrmHealth` não há tratamento: um timeout em qualquer uma das chamadas paralelas causa o `Promise.all` inteiro a rejeitar, e o endpoint retorna HTTP 500 sem indicar ao usuário quais dados foram carregados.
- **Impacto real:** Instabilidades momentâneas da API Ploomes (comuns em APIs SaaS) derrubam completamente as telas de dashboard e ranking. O usuário vê um erro genérico sem saber se é problema de rede, quota ou dado inexistente.
- **Risco futuro:** Com mais usuários simultâneos, a probabilidade de uma das dezenas de calls paralelas falhar por flakiness aumenta proporcionalmente.
- **Solução técnica:** Implementar retry com exponential backoff em `ploomesGetOnce`:
  ```javascript
  async function ploomesGetOnceWithRetry(urlPath, maxRetries = 3) {
    let delay = 500;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await ploomesGetOnce(urlPath);
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise(r => setTimeout(r, delay));
        delay *= 2; // exponential backoff
      }
    }
  }
  ```

---

**[🔴] Zero tratamento de rate limit (HTTP 429) — sem detecção nem throttle**
- **Descrição:** A API Ploomes tem limite de 6 requisições concorrentes (documentado no próprio código: `"Too many request concurrently, max is 6"`). O semáforo atual limita a 4 concorrentes, o que protege parcialmente. Porém:
  1. Não há detecção de HTTP 429 na resposta — a função verifica apenas se `parsed.value` é string (erro genérico), mas um 429 retorna um body diferente que pode resultar em "JSON parse error" ou ser tratado como dado inválido.
  2. Não há header `Retry-After` sendo lido.
  3. O `sync_warehouse.js` não tem semáforo — em um full extract, pode disparar múltiplas calls paralelas via `Promise.all` que excedem o limite.
- **Impacto real:** Se o rate limit for estourado (ex: múltiplos usuários simultâneos + sync em background), as respostas são silenciosamente descartadas como erros genéricos. Dados ficam incompletos sem aviso.
- **Risco futuro:** Com crescimento de usuários, o semáforo de 4 por instância não é suficiente — múltiplas instâncias do servidor ou múltiplos `sync_warehouse` simultâneos podem ultrapassar o limite global da conta Ploomes.
- **Solução técnica:** (1) Adicionar detecção de 429 no `ploomesGetOnce` verificando `res.statusCode`. (2) No caso de 429, aguardar `Retry-After` header ou fallback de 2s antes de retry. (3) Adicionar o mesmo semáforo do `server.js` ao `sync_warehouse.js`.

---

**[🔴] Sync do warehouse sem agendamento — dados ficam desatualizados sem aviso**
- **Descrição:** O warehouse é sincronizado apenas quando: (a) o usuário digita "me atualiza" no chat, ou (b) um request cai em `computeSalesIndicators`/`computeCrmHealth` e o warehouse está stale (`kickWarehouseSyncBackground`). Não existe nenhum cron job, `setInterval` ou agendador periódico no código. O método `kickWarehouseSyncBackground` tem proteção de 5 minutos entre spawns, mas apenas é chamado quando já há um request — ou seja, o warehouse pode ficar desatualizado por horas ou dias se ninguém usar o sistema.
- **Impacto real:** Um usuário que abre o dashboard pela manhã pode ver dados de D-2 ou D-3 sem nenhuma indicação visual de que os dados estão velhos. A flag `isWarehouseFresh(maxAgeMs=1h)` pode retornar false, mas o sistema simplesmente cai na API direta sem alertar que o warehouse está desatualizado.
- **Risco futuro:** Em produção 24/7, a expectativa implícita do usuário é que os dados sempre refletem D-1. Sem sync agendado, isso nunca é garantido.
- **Solução técnica:** Adicionar um cron job via `node-cron` ou `setInterval` no `server.js` para rodar `kickWarehouseSyncBackground('cron')` a cada hora:
  ```javascript
  setInterval(() => kickWarehouseSyncBackground('scheduled-hourly'), 60 * 60 * 1000);
  ```
  E no `ecosystem.config.js` (PM2) ou via systemd timer para garantir que o sync rode mesmo se o server reiniciar.

---

**[🟠] Falha parcial na paginação — sem reconciliação de dados incompletos**
- **Descrição:** `ploomesGetAll` pagina com `$top=100&$skip=N` incrementando até receber uma página com menos de 100 itens. Se a API falhar na **página 5 de 10** (timeout, erro 5xx), a função lança o erro e os registros das páginas 1-4 já coletados são **descartados** — a operação falha por completo. No `sync_warehouse.js`, isso resulta em `etl_runs.ok = 0` e o warehouse não é atualizado.
  
  O problema inverso também existe: se um registro é **deletado na API** entre a página 1 e a página 5, o skip pode pular um registro (problema clássico de cursor por offset em APIs sem cursor estável).
- **Impacto real:** Uma falha na metade de um sync full completo (ex: timeout na página 200 de 300 de deals) faz o warehouse ficar com versão anterior. Sem rollback, a próxima execução incremental parte do `last_ok.started_at` e pode pular os registros que seriam da falha.
- **Risco futuro:** Quanto maior a base de dados, maior a janela de tempo do sync, maior a probabilidade de falha parcial.
- **Solução técnica:** (1) Implementar checkpoint no `sync_warehouse.js`: salvar os IDs já processados por página em uma tabela de estado, permitindo retry da página N sem reprocessar 1 a N-1. (2) Ou usar `$filter=Id gt {lastId}` em vez de `$skip` para cursor estável. (3) Para o caso imediato, adicionar retry em `ploomesGetAll` para cada página individualmente.

---

**[🟠] Falhas silenciosas em funções críticas — erros engolidos sem log**
- **Descrição:** Diversas funções críticas retornam `{ error: e.message }` sem logar no console nem propagar o erro para o cliente de forma estruturada. Exemplos:
  - `getInteractionAggregates`, `ploomesGetTasksOwnerAggregates`, `ploomesGetLossReasonAggregates`: qualquer falha retorna `{ error: e.message }` — o LLM recebe isso como dado e pode interpretar como resposta válida ou ignorar silenciosamente.
  - `computeSalesIndicators`: o `catch (e) { return { error: e.message } }` faz o endpoint retornar HTTP 200 com um objeto de erro — o frontend pode não detectar a falha.
  - Em `computeCrmHealth`, o bloco try/catch do warehouse fallback usa `console.warn` mas não expõe ao usuário que o fallback para API ocorreu (dados podem ser mais lentos ou diferentes).
- **Impacto real:** O LLM pode gerar análises baseadas em dados parciais ou em mensagens de erro (`{ error: "Timeout" }`), produzindo respostas incorretas apresentadas como verdadeiras.
- **Risco futuro:** Impossível diagnosticar falhas em produção sem instrumentação adequada.
- **Solução técnica:** (1) Padronizar tratamento de erros: funções que falham devem lançar exceção ou retornar objeto com flag `ok: false` que o endpoint verifica antes de passar ao LLM. (2) Adicionar logging estruturado (ex: `console.error('[ploomesGetLossReasonAggregates] FAILED:', e)`). (3) Considerar integração com Sentry ou similar para alertas de erros em produção.

---

**[🟠] Timeout de 30s sem fallback — requests longos bloqueiam o event loop**
- **Descrição:** O timeout de 30 segundos é configurado como `timeout: 30000` na opção do `https.get`. Porém, o Node.js `https` não cancela a socket automaticamente no timeout — apenas emite o evento. O código trata corretamente com `.on('timeout', () => reject(...))`, mas o request pode continuar ativo por mais tempo internamente. Além disso, `ploomesGetAll` com `maxRecords=500000` (no sync) pode fazer centenas de chamadas sequenciais sem timeout global — se cada uma levar 29s, o sync pode durar horas.
- **Impacto real:** Syncs que demoram demais não têm timeout global. O processo filho do sync pode ficar pendurado indefinidamente, consumindo memória e bloqueando o próximo sync (pelo `warehouseSyncInFlightAt` de 5 min).
- **Risco futuro:** Em full extract com dados grandes, o sync pode nunca terminar em caso de degradação da API Ploomes.
- **Solução técnica:** (1) Adicionar `AbortController` com timeout global no `sync_warehouse.js` (ex: 30 minutos para full extract, 10 minutos para incremental). (2) No `ploomesGetOnce`, usar `req.destroy()` explicitamente no handler de timeout para garantir que a socket seja fechada.

---

**[🟡] Cache em memória sem persistência — invalidado a cada restart**
- **Descrição:** O `_ploomesCache` (Map em memória, TTL 60s) é perdido a cada reinício do servidor. O `dictionaryLoadedAt` (cache do dicionário de 30 min) também é perdido. Após cada deploy ou crash, o sistema faz um burst de chamadas à API para recarregar todos os dados em cache, potencialmente causando rate limit momentâneo.
- **Impacto real:** Pós-deploy, as primeiras N requisições simultâneas fazem todas elas bater na API ao mesmo tempo (thundering herd).
- **Risco futuro:** Com CI/CD frequente ou reinícios por PM2 em caso de crash, esse burst ocorre regularmente.
- **Solução técnica:** Persistir o dicionário no warehouse.db com TTL e recarregar na inicialização. O cache de 60s de respostas individuais pode permanecer em memória (low value to persist).

---

**[🟡] Divergência de exclusões entre server.js e sync_warehouse.js**
- **Descrição:** O `server.js` exclui `EXCLUDED_FROM_ANALYSIS = [10001176, 60023650, 10025857]` (3 usuários). O `sync_warehouse.js` exclui apenas `EXCLUDED_FROM_ANALYSIS = [10001176]` (1 usuário). Isso significa que Sarah Baliana (ID: 60023650) e o usuário FATURAMENTO (ID: 10025857) têm seus dados armazenados no warehouse mas são excluídos nas queries do server.js — inconsistência que pode gerar divergência entre análises do warehouse e análises diretas da API.
- **Impacto real:** Relatórios baseados no warehouse podem incluir dados de usuários que deveriam ser excluídos (ex: score de higiene, contagens de deals), enquanto análises em tempo real os excluem. Dois usuários consultando a mesma métrica podem ver valores diferentes dependendo do caminho de código (warehouse vs API direta).
- **Risco futuro:** Toda vez que a lista de excluídos mudar no `server.js`, é necessário lembrar de atualizar o `sync_warehouse.js` também — sem mecanismo automático de sincronização.
- **Solução técnica:** Extrair `EXCLUDED_FROM_ANALYSIS` e `INACTIVE_PIPELINE_IDS` para um arquivo de configuração compartilhado (ex: `config/constants.js`) que ambos os scripts importam. Garantir única fonte de verdade.

---

**[🟡] Reconciliação de divergências API vs warehouse — sem mecanismo**
- **Descrição:** O sync incremental usa `LastUpdateDate ge {sinceDate - 2 dias}` para capturar mudanças. Isso resolve a maioria dos casos, mas não cobre: (a) registros deletados na API que permanecem no warehouse; (b) deals cuja `LastUpdateDate` não foi atualizada (ex: mudança de stage sem `LastUpdateDate` sendo tocado pela API Ploomes); (c) deals criados antes do período incremental mas alterados em campos não cobertos pelo select.
- **Impacto real:** O warehouse pode ter deals "zumbis" (deletados no Ploomes mas ainda presentes localmente) que inflam contagens de pipeline em aberto.
- **Risco futuro:** Com o tempo, a divergência acumula. Um full extract manual é necessário periodicamente — mas não há alerta automático indicando quando fazer isso.
- **Solução técnica:** (1) Adicionar uma rotina de reconciliação semanal (full extract automático aos domingos via cron). (2) Comparar count de deals ativos na API vs warehouse semanalmente e logar divergências acima de 5%.

---

**[🟢] Boas práticas já implementadas**
- **Descrição:** O código tem vários pontos positivos que merecem registro:
  - Semáforo de concorrência (máx 4 calls simultâneas) previne estouro do limite da API.
  - Cache em memória de 60s reduz chamadas repetidas dentro de um mesmo request.
  - `enforceDateFilterOrThrow` garante que endpoints que retornam dados grandes (Deals, Tasks, InteractionRecords) sempre tenham filtro de data — prevenindo full scans acidentais.
  - `sanitizeDealSelectGlobal` remove campos proibidos do `$select` automaticamente.
  - ETL separado em processo filho (spawn detached) evita que sync longo bloqueie o servidor web.
  - `resolveDataSource` implementa lógica de 3 camadas (warehouse → recente → API direta) com watermark D-1, evitando dados parciais do dia corrente.
- **Impacto real:** Sem problemas nestes pontos — são práticas corretas a manter.
- **Solução técnica:** Documentar essas práticas em ARCHITECTURE.md para que futuras contribuições as respeitem.

---

## Sumário de Prioridades

| Prioridade | Item |
|---|---|
| 🔴 Crítico | Zero retry — falhas de API derrubam operações inteiras |
| 🔴 Crítico | Zero tratamento de HTTP 429 — rate limit não detectado |
| 🔴 Crítico | Sem cron de sync — warehouse envelhece sem trigger automático |
| 🟠 Alta | Falha parcial na paginação sem reconciliação |
| 🟠 Alta | Falhas silenciosas — erros chegam ao LLM como dados |
| 🟠 Alta | Timeout sem fallback global no sync |
| 🟡 Média | Cache em memória sem persistência (thundering herd pós-restart) |
| 🟡 Média | Divergência de exclusões server.js vs sync_warehouse.js |
| 🟡 Média | Sem reconciliação automática API vs warehouse |
| 🟢 OK | Semáforo, cache 60s, enforceDateFilter, ETL em processo filho |

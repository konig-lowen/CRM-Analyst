# AUDIT PHASE 5 — Coach AI
> Auditoria realizada em: 2026-05-20
> Arquivos analisados: server.js (/api/chat/coach), coach.html, app.html (renderCoach)

---

## Resumo Executivo

O Coach AI é a feature mais sofisticada do sistema. O endpoint `/api/chat/coach` injecta contexto rico (saúde do CRM, indicadores calculados, histórico de sessão, mapeamento de usuários/funis/motivos de perda) e executa até 5 rounds de fetch à API Ploomes antes de gerar a resposta final via Claude. O system prompt é extenso, bem estruturado e cobre muitos edge cases. No entanto, há problemas sérios de token bloat (contexto cresce sem controle), memória de sessão limitada e superficial, e riscos de custo operacional significativos.

---

## Problemas Identificados

---

**[🔴] Token bloat — contexto cresce sem limite a cada mensagem**
- **Descrição:** A cada chamada ao `/api/chat/coach`, são injetados no payload:
  1. `crmHealthContextCoach` — estado completo do CRM (todos os vendedores com scores, abandoned, noValue, lostNoReason) ~500-800 tokens
  2. `salesIndicatorsContextCoach` — indicadores calculados: conversão por funil, ticket médio por funil, abandonados por owner, fill rate por owner ~600-1000 tokens
  3. `fonteContextCoach` — fonte e período dos dados ~100 tokens
  4. Lista de todos os vendedores ativos com IDs ~100-300 tokens
  5. Mapeamento completo de todos os usuários (dict.users) ~300-600 tokens
  6. Todos os funis (dict.pipelineById) ~100-200 tokens
  7. Todos os motivos de perda (dict.lossReasonById) ~100-200 tokens
  8. Histórico de conversa: últimas 16 mensagens da sessão (sem limite de tamanho por mensagem)
  
  Em uma sessão longa com respostas extensas do coach (que podem ter 800-1500 tokens cada), o histórico de 16 mensagens sozinho pode chegar a 24.000 tokens. Somando todos os injeções, o contexto total por chamada pode facilmente passar de **30.000-40.000 tokens**.
- **Impacto real:** Custo por conversa do coach é extremamente alto. Com Claude Sonnet, 40k tokens de entrada = ~$0.12 por mensagem. Em 100 conversas/dia, isso é ~$12/dia só de input tokens do coach.
- **Risco futuro:** Sem cap, uma conversa suficientemente longa pode atingir o limite de contexto do modelo (200k tokens para Claude 3.5), causando erros ou respostas truncadas. O custo também é não-previsível.
- **Solução técnica:**
  1. Limitar histórico a últimas 8 mensagens (em vez de 16) e truncar mensagens longas a 500 chars.
  2. Injetar `crmHealthContextCoach` e `salesIndicatorsContextCoach` apenas se a pergunta for sobre performance/dados (detectar por keywords), não em todas as mensagens.
  3. Cachear o contexto injetado e reutilizar entre rodadas de fetch (já existe `sessionCacheCtx` para fetches, mas não para o contexto estático).

---

**[🔴] Memória de coach — sem persistência entre sessões diferentes**
- **Descrição:** A "memória" do coach é baseada em `messages WHERE session_id = ? ORDER BY id DESC LIMIT 16`. O `session_id` é o ID da sessão HTTP do usuário (cookie de sessão). Quando o usuário fecha o browser, perde a sessão HTTP, e toda a história da conversa de coach é perdida. Os `coaching_summaries` são salvos no banco, mas só são injetados como **lista lateral visual** — não são injetados no system prompt do Claude.
- **Impacto real:** O coach não se lembra de conversas anteriores. Um vendedor que na segunda-feira discutiu um deal específico, na terça começa do zero. O historial de summaries existe no banco mas não é utilizado para contextualizar o coach.
- **Risco futuro:** Feature "Coach" perde valor longitudinal — o principal diferencial de um coach real é a continuidade.
- **Solução técnica:** Injetar os últimos 3-5 `coaching_summaries` do usuário no system prompt como "contexto de sessões anteriores". Exemplo:
  ```
  [SESSÕES ANTERIORES DO COACH]:
  - 2026-05-15: Vendedor discutiu dificuldade em fechamento no funil Prospecção. Ação acordada: revisar cadência de follow-up.
  - 2026-05-10: Análise de 3 deals perdidos por "concorrente". Hipótese: preenchimento incorreto.
  ```

---

**[🔴] Prompt do coach não induz geração de [COACH_SUMMARY] — persistência de aprendizado falha**
- **Descrição:** O sistema captura `[COACH_SUMMARY]...[/COACH_SUMMARY]` da resposta do Claude e persiste no banco. Porém, o system prompt não inclui instrução explícita para gerar esse bloco ao final de cada resposta. O Claude só gera se "entender" que deve pelo padrão — o que não é garantido.
- **Impacto real:** Em testes ou uso real, grande parte das conversas do coach não gera summary, resultando em banco vazio de summaries. Dados que deveriam alimentar continuidade e o score CRM (bônus de 2 pontos/semana de coach) são perdidos.
- **Risco futuro:** O sistema de gamificação (pontuação do coach no ranking) é quebrado silenciosamente — o usuário usa o coach mas não recebe os pontos.
- **Solução técnica:** Adicionar ao final do system prompt instrução explícita:
  ```
  ## GERAÇÃO DE SUMMARY (OBRIGATÓRIO)
  Ao final de CADA resposta de coaching substantivo (não de perguntas simples de esclarecimento), adicione obrigatoriamente:
  [COACH_SUMMARY]
  Resumo em 2-3 linhas: o que foi discutido, hipótese principal levantada, ação acordada.
  [/COACH_SUMMARY]
  ```

---

**[🟠] Contexto de todos os usuários/funis/motivos exposto na mensagem do usuário**
- **Descrição:** A cada chamada ao coach, a mensagem enviada ao Claude inclui:
  ```
  Vendedores ativos (nome->id para filtros de busca, NÃO MOSTRE NA RESPOSTA): [lista completa]
  Mapeamento completo IDs->Nomes (use para resolver IDs nos dados da API, NÃO MOSTRE ESTA LISTA): [lista completa]
  Funis (PipelineId->Nome, NÃO MOSTRE ESTA LISTA): [lista completa]
  Motivos de perda (LossReasonId->Nome, NÃO MOSTRE ESTA LISTA): [lista completa]
  ```
  Esses dados são injetados como texto puro no campo `content` da mensagem do usuário (não no system prompt). A instrução "NÃO MOSTRE" é um guardrail frágil — o modelo pode citar esses dados em suas respostas.
- **Impacto real:** Risco de vazar lista de vendedores, IDs internos, e estrutura do funil para o usuário final se o Claude citar a lista em alguma resposta. Em vendedores que não deveriam ver outros nomes, isso é problema.
- **Risco futuro:** Se a lista crescer (novos usuários, funis, motivos), os tokens gastos com esses dicionários aumentam a cada chamada.
- **Solução técnica:** Mover os dicionários para o system prompt (onde têm maior peso e menos risco de serem citados literalmente), e reduzir a lista de usuários ativos apenas aos relevantes para o contexto (ex.: para vendedor, incluir apenas o próprio; para admin, incluir apenas os do time).

---

**[🟠] Sem controle de custo por sessão — fetches custam sem limite**
- **Descrição:** O loop de fetches roda até 5 rounds. Em cada round, o Claude pode emitir múltiplos JSONs de fetch. O código processa `jsonMatches` em paralelo sem limite de quantos fetches por round. Uma resposta do Claude com 10 fetch JSONs faria 10 chamadas à API Ploomes simultaneamente.
- **Impacto real:** Uma pergunta complexa pode fazer 5 rounds × N fetches = dezenas de chamadas à API Ploomes. Cada fetch retorna até 20 registros de amostra + agregados, e tudo isso é enviado de volta ao Claude — mais tokens, mais custo.
- **Risco futuro:** Com usuários mais exigentes ou perguntas abertas, o custo por mensagem pode ser imprevisível.
- **Solução técnica:** Limitar a 3 fetches por round (priorizar os mais relevantes por descrição). Adicionar log de custo estimado por chamada e alerta se passar de threshold configurável.

---

**[🟠] Inconsistência de sessão — o histórico do coach usa session_id da sessão HTTP, não chat_session_id**
- **Descrição:** No endpoint `/api/chat/coach`:
  ```js
  const history = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 16').all(sessionId).reverse();
  ```
  onde `sessionId = req.session.id` (sessão HTTP). Mas as mensagens são salvas com `chat_session_id` também. A query não filtra por `chat_session_id`, então o histórico pode misturar mensagens de sessões de coach diferentes (ou com o chat principal).
- **Impacto real:** Se o usuário tem conversas de chat genérico e de coach na mesma sessão HTTP, o histórico injetado no coach pode incluir mensagens do chat (perguntas sobre pipeline, etc.) que não são relevantes para o coaching.
- **Risco futuro:** Confusão de contexto aumenta com o uso do sistema. O coach pode "lembrar" de um contexto de chat que não é de coaching.
- **Solução técnica:** Filtrar o histórico por tipo: `WHERE session_id = ? AND chat_session_id = ? ORDER BY id DESC LIMIT 16`, ou criar uma tabela separada `coach_messages`.

---

**[🟠] Latência — computeSalesIndicators e computeCrmHealth são síncronos no request**
- **Descrição:** Antes de responder ao usuário, o endpoint coach executa:
  1. `computeCrmHealth()` — calcula higiene do CRM (múltiplas queries SQLite)
  2. `computeSalesIndicators()` — calcula indicadores de vendas (múltiplas queries SQLite + lógica complexa)
  
  Ambos executam de forma sequencial dentro do handler. Mesmo que sejam rápidos no SQLite local, adicionam latência perceptível antes da primeira chamada ao Claude.
- **Impacto real:** Tempo de resposta do coach inclui o tempo de computação dos indicadores. Em servidores com disco lento ou SQLite grande, pode adicionar 200-500ms.
- **Risco futuro:** Com crescimento do banco de dados, essas queries ficam mais lentas.
- **Solução técnica:** Executar `computeCrmHealth()` e `computeSalesIndicators()` em paralelo via `Promise.all()`. Cachear os resultados com TTL de 1h (já existe infra de cache no servidor para isso).

---

**[🟡] Qualidade dos prompts — estrutura obrigatória de resposta pode ser ignorada em perguntas simples**
- **Descrição:** O system prompt exige estrutura obrigatória de 5 pontos (Contexto, Hipóteses, Desenvolvimento, Ações, Pergunta reflexiva) em TODA resposta de coaching. Para perguntas simples de esclarecimento ("o que é SPIN Selling?"), essa estrutura é desnecessária e resulta em respostas artificialmente longas.
- **Impacto real:** Respostas infladas para perguntas simples. Mais tokens, custo maior, UX pior.
- **Risco futuro:** Usuário sente que o coach "enrola" em vez de responder direto.
- **Solução técnica:** Adicionar ao prompt: "Para perguntas de esclarecimento rápido ou conversacionais, responda de forma concisa sem a estrutura completa. Use a estrutura completa apenas para análises de performance ou diagnóstico de situação de venda."

---

**[🟡] Rastreabilidade — respostas do coach não são logadas com metadados de custo**
- **Descrição:** As respostas são salvas na tabela `messages` e os summaries em `coaching_summaries`, mas não há log de:
  - Número de tokens usados por chamada
  - Modelo utilizado
  - Número de rounds de fetch executados
  - Tempo de resposta (latência)
  - Target_ploomes_id (qual vendedor estava sendo coachado)
- **Impacto real:** Impossível auditar custo por usuário, por vendedor coachado, ou identificar conversas problemáticas (muito longas, muitos fetches).
- **Risco futuro:** À medida que o uso cresce, sem rastreabilidade é impossível otimizar custo ou identificar abusos.
- **Solução técnica:** Adicionar tabela `coach_interactions_log` com campos: `user_id`, `target_ploomes_id`, `model`, `rounds`, `total_fetches`, `latency_ms`, `created_at`. Logar ao final de cada chamada bem-sucedida.

---

**[🟡] Consistência — histórico limitado a 16 mensagens pode quebrar contexto de diagnóstico em andamento**
- **Descrição:** O histórico de 16 mensagens (8 pares de pergunta/resposta) é um limite razoável, mas o coach pode estar no meio de uma análise aprofundada quando o histórico começa a ser truncado (as mensagens mais antigas são descartadas).
- **Impacto real:** O coach pode contradizer o que disse 10 mensagens atrás se aquelas mensagens já saíram do histórico. Ex.: "Antes você disse que minha conversão estava em 30%. Mas agora está dizendo que está em 45%." — o coach não tem mais o contexto.
- **Risco futuro:** Em sessões longas (frequentes com usuários engajados), a inconsistência será percebida.
- **Solução técnica:** Implementar sumarização progressiva: quando o histórico passa de 12 mensagens, gerar um mini-resumo das mensagens mais antigas e injetá-lo como contexto em vez das mensagens brutas. Similar ao pattern de "rolling summary" em aplicações de LLM de longa duração.

---

**[🟡] Alucinação — indicadores calculados injetos mas o modelo pode recalcular**
- **Descrição:** O prompt diz explicitamente: `"NÃO recalcule fórmulas"` e `"Use os números injetados diretamente"`. Mas quando o Claude faz fetches de dados brutos em paralelo (ex.: lista de deals ganhos), ele pode calcular taxas de conversão por conta própria — e esses cálculos podem diferir dos indicadores pré-calculados pelo servidor (que têm lógica mais sofisticada: exclusão de funis, filtros de owner, etc.).
- **Impacto real:** O usuário pode receber dois números diferentes para a mesma métrica na mesma sessão (um dos indicadores injetados, outro do Claude calculando na hora).
- **Risco futuro:** Confiança no sistema diminui se o usuário perceber inconsistências.
- **Solução técnica:** Quando `[INDICADORES CALCULADOS]` estão presentes, bloquear fetches de Deals que recalculariam as mesmas métricas. Ou adicionar instrução: "Se você recalcular uma métrica a partir de fetch e o resultado divergir dos [INDICADORES CALCULADOS], use sempre os indicadores calculados e mencione a divergência."

---

## Resumo de Prioridades

| Severidade | Quantidade | Itens principais |
|------------|-----------|------------------|
| 🔴 Crítico | 3 | Token bloat sem controle, memória entre sessões inexistente, summary não gerado sistematicamente |
| 🟠 Alto | 4 | Dicionários expostos na mensagem do usuário, fetches sem limite, histórico mistura sessões, latência de computação síncrona |
| 🟡 Médio | 4 | Estrutura obrigatória inflada, sem rastreabilidade de custo, inconsistência de histórico longo, alucinação de recálculo |

**Ação de maior impacto:** Implementar o `[COACH_SUMMARY]` obrigatório no prompt (5 min de trabalho, habilita memória e gamificação) e reduzir o histórico de 16 para 8 mensagens com truncamento de mensagens longas (reduz custo em ~40%).

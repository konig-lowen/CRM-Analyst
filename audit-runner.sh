#!/usr/bin/env bash
# audit-runner.sh — Executa auditoria completa em fases via Claude Code
# Roda enquanto o usuário dorme. Salva progresso em AUDIT_PROGRESS.md.
# Retomável: verifica checkboxes antes de cada fase.

set -euo pipefail

PROJECT="/opt/ploomes-analyst"
PROGRESS="$PROJECT/AUDIT_PROGRESS.md"
LOG="$PROJECT/AUDIT_RUNNER.log"
CC="claude -p --model sonnet"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }
check_done() { grep -q "\[x\] $1" "$PROGRESS" 2>/dev/null; }
mark_done() {
  sed -i "s/\[ \] $1/[x] $1/" "$PROGRESS"
  log "✅ $1 concluída"
}
mark_error() {
  echo "- ❌ $1: $2" >> "$PROGRESS"
  log "❌ ERRO em $1: $2"
}

log "=== Iniciando auditoria CRM Analyst ==="

# ─────────────────────────────────────────────
# FASE 1 — Leitura do codebase
# ─────────────────────────────────────────────
FASE="FASE 1 — Leitura do codebase"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT='Você está auditando o sistema CRM Ploomes Analyst em /opt/ploomes-analyst.

FASE 1 — Mapeamento do codebase.

Faça o seguinte e salve em /opt/ploomes-analyst/AUDIT_F1_codebase.md:

1. Liste todos os arquivos relevantes (server.js, *.html, scripts/, schemas) com tamanhos
2. Mapeie todas as rotas /api/* do server.js (método, path, auth, descrição)
3. Mapeie todas as funções principais do server.js (nome, propósito, dependências)
4. Liste todas as tabelas do warehouse.db e history.db com colunas e índices
5. Mapeie o fluxo de dados: API Ploomes → ETL → warehouse.db → rotas → frontend
6. Identifique todos os pontos onde IA (Anthropic) é chamada: qual função, qual model, qual prompt
7. Liste todas as dependências npm e suas versões
8. Identifique variáveis de ambiente esperadas

Seja exaustivo. Isso é a base para as fases seguintes.'

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F1_codebase.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 2 — Auditoria Backend
# ─────────────────────────────────────────────
FASE="FASE 2 — Auditoria Backend (server.js)"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  F1=$(cat "$PROJECT/AUDIT_F1_codebase.md" 2>/dev/null | head -200)
  PROMPT="Você é um arquiteto sênior auditando o backend do CRM Ploomes Analyst.

Contexto do codebase (mapeamento fase 1):
$F1

Arquivo principal: /opt/ploomes-analyst/server.js

Analise o server.js completamente e audite:

1. ARQUITETURA
- separação de responsabilidades
- acoplamento entre módulos
- ausência de camadas (service layer, repository layer)
- Express configurado corretamente?
- middleware ordering

2. SEGURANÇA
- credenciais hardcoded
- session secret fraco
- validação de entrada em cada rota
- SQL injection risks (even with prepared statements)
- autorização: cada rota verifica role corretamente?
- vazamento de dados entre usuários (ex: supervisor vendo dados de outro supervisor)
- CORS
- rate limiting

3. CONCORRÊNCIA E ESCALABILIDADE
- race conditions possíveis
- shared mutable state
- SQLite write locks (single-writer problem)
- requests síncronos que bloqueiam o event loop
- falta de filas para operações pesadas

4. TRATAMENTO DE ERROS
- erros não capturados
- falhas silenciosas
- retry logic
- circuit breaker ausente
- respostas de erro inconsistentes

5. PERFORMANCE
- N+1 queries identificadas
- queries sem índice
- chamadas Ploomes API síncronas em série
- falta de cache onde deveria ter
- computações pesadas no request cycle

6. OBSERVABILIDADE
- logging adequado?
- rastreabilidade de requests
- métricas de latência
- auditoria de ações do usuário

Para cada problema:
- Explique o problema
- Impacto real
- Risco futuro
- Prioridade (CRÍTICO/ALTO/MÉDIO/BAIXO)
- Solução técnica detalhada

Salve em /opt/ploomes-analyst/AUDIT_F2_backend.md"

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F2_backend.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 3 — Auditoria Banco de Dados
# ─────────────────────────────────────────────
FASE="FASE 3 — Auditoria Banco de Dados"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"

  # Extrair schema real dos bancos
  SCHEMA=$(cd /opt/ploomes-analyst && node -e "
const db1 = require('better-sqlite3')('./warehouse.db');
const db2 = require('better-sqlite3')('./history.db');

function describeDb(db, name) {
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
  let out = '=== ' + name + ' ===\n';
  for (const t of tables) {
    const cols = db.prepare('PRAGMA table_info(' + t.name + ')').all();
    const idxs = db.prepare('PRAGMA index_list(' + t.name + ')').all();
    const cnt = db.prepare('SELECT count(*) as n FROM ' + t.name).get();
    out += t.name + ' (' + cnt.n + ' rows):\n';
    cols.forEach(c => out += '  ' + c.name + ' ' + c.type + (c.pk?' PK':'') + (c.notnull?' NOT NULL':'') + '\n');
    idxs.forEach(i => {
      const icols = db.prepare('PRAGMA index_info(' + i.name + ')').all().map(x=>x.name).join(',');
      out += '  INDEX ' + i.name + ' ON (' + icols + ')\n';
    });
    out += '\n';
  }
  return out;
}

console.log(describeDb(db1, 'warehouse.db'));
console.log(describeDb(db2, 'history.db'));
" 2>/dev/null)

  PROMPT="Você é um arquiteto sênior auditando o banco de dados do CRM Ploomes Analyst.

Schema completo dos bancos:
$SCHEMA

Também analise o sync_warehouse.js em /opt/ploomes-analyst/scripts/ para entender o ETL.

Audite:

1. MODELAGEM
- o schema representa corretamente o domínio?
- há desnormalização desnecessária?
- falta de foreign keys (SQLite não enforça por padrão)
- ausência de constraints
- tipos de dados inadequados
- campos que deveriam ser NOT NULL mas não são

2. ÍNDICES
- quais queries existem no server.js que fazem full table scan?
- índices compostos faltando
- índices inúteis ou redundantes
- queries de ordenação sem índice

3. CONSISTÊNCIA E INTEGRIDADE
- risco de dados órfãos
- duplicidade de dados entre warehouse e history
- dados que podem divergir da API Ploomes
- campo updated_at sendo usado corretamente para sync incremental?

4. MATERIALIZED VIEWS
- lógica das MVs está correta?
- mv_hygiene: o que define 'deal abandonado'? Essa definição é operacionalmente correta?
- mv_conversion: calcula taxa corretamente?
- mv_loss_reasons: agrupamento correto?
- as MVs são recalculadas corretamente no ETL?

5. ETL E SINCRONIZAÇÃO
- o ETL é incremental ou full reload?
- risco de perda de dados durante sync
- o que acontece se o ETL falhar no meio?
- race condition entre ETL rodando e queries do servidor
- sem agendamento automático (identificado antes — detalhar impacto)

6. CRESCIMENTO E ESCALABILIDADE
- SQLite é adequado a longo prazo?
- projeção de crescimento com mais vendedores/deals
- limites do SQLite single-writer

Para cada problema: impacto, risco, prioridade, solução.

Salve em /opt/ploomes-analyst/AUDIT_F3_database.md"

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F3_database.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 4 — Auditoria Frontend
# ─────────────────────────────────────────────
FASE="FASE 4 — Auditoria Frontend (HTMLs)"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT='Você é um arquiteto sênior auditando o frontend do CRM Ploomes Analyst.

Arquivos em /opt/ploomes-analyst/:
- app.html (chat principal dos vendedores)
- coach.html (coach AI)
- dashboard.html (KPIs)
- ranking.html (gamificação)
- reports.html (relatórios)
- admin.html (administração)
- index.html / login.html

Analise cada arquivo e audite:

1. ARQUITETURA FRONTEND
- HTML monolítico com JS inline: riscos?
- ausência de framework/bundler: impacto em manutenção e escala
- gerenciamento de estado: como o estado é mantido entre telas?
- sem SPA router: como a navegação funciona?

2. CHAMADAS DE API
- quais endpoints são chamados em cada tela?
- há chamadas redundantes (mesmo dado buscado múltiplas vezes)?
- há polling? Com qual frequência?
- os dados são cacheados no frontend?
- o que acontece se a chamada falhar? Há feedback ao usuário?

3. SEGURANÇA FRONTEND
- tokens/credenciais expostos no HTML?
- XSS: há innerHTML com dados não sanitizados?
- dados de outros usuários podem vazar via JS?
- o frontend valida autorização além do que o backend retorna?

4. UX OPERACIONAL
- o vendedor consegue entender o que precisa fazer?
- há informação de ação (o que fazer agora) ou apenas métricas?
- loading states adequados?
- tratamento de erro visível ao usuário?
- mobile-friendly?

5. PERFORMANCE FRONTEND
- assets pesados?
- fontes/bibliotecas externas (CDN) que podem falhar?
- render bloqueante?

6. SEMÂNTICA DOS DADOS EXIBIDOS
- os números no dashboard correspondem ao que o usuário espera?
- há risco de confusão entre "deals do vendedor" vs "deals do time"?
- períodos de tempo estão claramente indicados?
- timezone exibido corretamente?

Para cada problema: impacto, prioridade, solução.
Seja específico: cite o arquivo, a linha/função quando possível.

Salve em /opt/ploomes-analyst/AUDIT_F4_frontend.md'

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F4_frontend.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 5 — Auditoria CRM API Integration
# ─────────────────────────────────────────────
FASE="FASE 5 — Auditoria CRM API Integration"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT='Você é um arquiteto sênior auditando a integração com a API do Ploomes CRM.

Analise no server.js e scripts/ tudo relacionado à integração com a API Ploomes:
- função ploomesGet, ploomesGetAll ou similar
- ETL em scripts/sync_warehouse.js (se existir)
- endpoints que chamam Ploomes diretamente (não via warehouse)
- fetch_cache no history.db

Audite:

1. FREQUÊNCIA E CONSISTÊNCIA
- quais endpoints ainda chamam Ploomes diretamente (bypassando warehouse)?
- esses dados podem divergir do warehouse?
- há risco do usuário ver dados diferentes dependendo de qual path seguiu?

2. PAGINAÇÃO E COMPLETUDE
- a paginação está correta? Usa $top/$skip ou cursor?
- há risco de dados truncados (ex: busca os primeiros 100 deals mas existem 500)?
- o ploomesGetAll garante que todos os registros são recuperados?

3. RATE LIMIT E RETRY
- há tratamento de rate limit (429)?
- há retry com backoff exponencial?
- o que acontece quando Ploomes API está fora do ar?
- há circuit breaker?
- há fallback para warehouse quando API falha?

4. SINCRONIZAÇÃO INCREMENTAL
- o ETL busca todos os dados sempre, ou apenas delta?
- se full reload: impacto em performance e rate limit
- o campo updated_at é usado para sync incremental?
- risco de perda de dados deletados no CRM (soft delete vs hard delete)

5. FALHAS SILENCIOSAS
- erros da API Ploomes são logados?
- há casos onde a chamada falha mas o usuário vê dados vazios sem mensagem?
- o ETL reporta falhas parciais?

6. AUTENTICAÇÃO
- como a API key é rotacionada?
- o que acontece quando a API key expira?

Para cada problema: impacto real, prioridade, solução técnica detalhada.

Salve em /opt/ploomes-analyst/AUDIT_F5_api_integration.md'

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F5_api_integration.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 6 — Auditoria Coach AI
# ─────────────────────────────────────────────
FASE="FASE 6 — Auditoria Coach AI & Prompts"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT='Você é um arquiteto sênior especialista em IA aplicada auditando o Coach AI do CRM Ploomes Analyst.

Analise no server.js:
- todas as funções que chamam a API Anthropic (askClaude, askClaudeMessages ou similares)
- os prompts do coach (system prompt, user prompt)
- como o contexto de dados é montado antes de enviar para IA
- como coaching_summaries e predictions são usados
- como o fetch_cache interage com as chamadas de IA
- o endpoint /api/chat/coach

Audite:

1. QUALIDADE DO CONTEXTO
- quais dados são enviados para a IA no contexto?
- o contexto representa fielmente a realidade operacional do vendedor?
- há risco de contexto desatualizado (dados do warehouse antigos)?
- o contexto é suficiente para gerar recomendações acionáveis?
- quais dados DEVERIAM estar no contexto mas não estão?

2. QUALIDADE DOS PROMPTS
- o system prompt instrui a IA a agir como coach comercial ou apenas responder perguntas?
- há instruções de "não alucinar" ou "diga quando não souber"?
- o prompt incentiva recomendações acionáveis ou respostas genéricas?
- há exemplos (few-shot) de boas respostas de coaching?
- o prompt define claramente o que é uma boa recomendação vs uma ruim?

3. RISCO DE HALLUCINATION
- a IA pode inventar métricas que não existem no contexto?
- a IA pode recomendar ações baseadas em dados que não foram fornecidos?
- há mecanismo para a IA admitir incerteza?
- há validação pós-resposta?

4. MEMÓRIA E CONTINUIDADE
- a IA lembra de conversas anteriores com o mesmo vendedor?
- coaching_summaries é usado como contexto histórico?
- há risco de o coach contradizer recomendações anteriores?
- o histórico de sessões é passado corretamente?

5. CUSTO E LATÊNCIA
- qual o tamanho médio do contexto enviado?
- há token bloat (dados desnecessários no prompt)?
- qual model é usado? É adequado para a complexidade da tarefa?
- há cache de respostas para perguntas repetidas?
- o fetch_cache está funcionando corretamente?

6. INFERÊNCIAS E VIESES
- o coach pode gerar recomendações prejudiciais ao vendedor?
- há viés em como os dados são apresentados à IA?
- o coach incentiva comportamentos corretos ou apenas volume?
- as conclusões da IA são rastreáveis (qual dado gerou qual conclusão)?

7. AUDITORIA DAS RESPOSTAS
- as respostas do coach são logadas?
- há como auditar o que foi recomendado vs o que aconteceu?
- há rastreabilidade das decisões da IA?

Para cada problema: impacto, risco de negócio, prioridade, solução.

Salve em /opt/ploomes-analyst/AUDIT_F6_coach_ai.md'

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F6_coach_ai.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 7 — Dashboards, KPIs, Gamificação
# ─────────────────────────────────────────────
FASE="FASE 7 — Auditoria Dashboards, KPIs, Gamificação"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT='Você é um arquiteto sênior auditando os dashboards, KPIs e gamificação do CRM Ploomes Analyst.

Analise no server.js:
- função computeDashboard (ou similar) — como KPIs são calculados
- função computeRanking — como o ranking é calculado
- endpoint /api/dashboard
- endpoint /api/ranking
- endpoint /api/goals
- as materialized views: mv_pipeline_snapshot, mv_conversion, mv_loss_reasons, mv_hygiene
- o arquivo dashboard.html e ranking.html

Audite:

1. CONFIABILIDADE DOS KPIs
- taxa de conversão: numerador e denominador corretos? Qual período base?
- deals ganhos/perdidos: usa finish_date ou outro campo? Timezone tratado?
- valor em pipeline: soma amount de deals status=1? E deals sem amount?
- ticket médio: média ou mediana? Inclui outliers?
- hygiene score: quais critérios? Essa definição é operacionalmente correta?

2. DIVERGÊNCIA TEMPORAL
- os KPIs usam a mesma janela de tempo?
- há inconsistência entre KPI A usando "últimos 30 dias" e KPI B usando "mês atual"?
- timezone: os dados estão em UTC no banco mas exibidos sem conversão?
- deals criados em 31/jan 23:59 UTC pertencem a jan ou fev no relatório?

3. MÉTRICAS MANIPULÁVEIS
- o ranking pode ser inflado por ações vazias (criar/deletar interações)?
- um vendedor pode mover deal entre stages para ganhar pontos?
- metas podem ser ajustadas retroativamente afetando o ranking histórico?
- o hygiene score pode ser "jogado" sem trabalho real?

4. INCENTIVOS DA GAMIFICAÇÃO
- o ranking incentiva velocidade e qualidade, ou apenas volume?
- há penalização por deals parados?
- há diferenciação por valor do deal ou apenas contagem?
- qual comportamento real o ranking mais premia? É o comportamento desejado?
- há loopholes identificáveis?

5. SEMÂNTICA DOS RELATÓRIOS
- os relatórios exportáveis representam fielmente os dados do período?
- há risco de dados parciais em relatórios do mês em andamento?
- as comparações com período anterior são semanticamente corretas?

6. INCONSISTÊNCIAS FRONTEND/BACKEND
- o que dashboard.html exibe vs o que /api/dashboard retorna: são iguais?
- há transformações de dados no frontend que podem introduzir erros?

Para cada problema: impacto operacional, prioridade, solução detalhada.

Salve em /opt/ploomes-analyst/AUDIT_F7_dashboards.md'

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F7_dashboards.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 8 — Evolução Estratégica
# ─────────────────────────────────────────────
FASE="FASE 8 — Evolução Estratégica"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"

  SUMMARY=""
  for f in F2 F3 F4 F5 F6 F7; do
    FILE="$PROJECT/AUDIT_${f}_*.md"
    CONTENT=$(ls $FILE 2>/dev/null | head -1 | xargs head -50 2>/dev/null)
    SUMMARY="$SUMMARY\n\n--- $f ---\n$CONTENT"
  done

  PROMPT="Você é um arquiteto sênior e estrategista de produto analisando o CRM Ploomes Analyst.

Resumo das auditorias técnicas anteriores:
$SUMMARY

O sistema atual funciona como: chat AI + dashboard + coach + ranking sobre dados do Ploomes CRM.

Proposta estratégica obrigatória:

1. ENGINE DE INSIGHTS
- O sistema atualmente apenas responde perguntas. Proponha arquitetura para gerar insights proativamente.
- Pipeline de inferência: regras determinísticas + IA híbrida
- Scores: risco de perda, oportunidade, produtividade, aderência ao processo
- Detecção de anomalias: deals parados, pipeline deteriorando, queda de performance
- Seja específico: quais tabelas/dados alimentam cada score? Qual algoritmo? Como apresentar?

2. MEMÓRIA COMERCIAL PERSISTENTE
- Hoje o sistema não tem memória comportamental do vendedor.
- Proponha: event store de ações comerciais, timeline por deal/vendedor, embeddings de padrões
- Modele os eventos: lead_criado, stage_alterado, follow_up_perdido, atraso_detectado, etc.
- Proponha schema de tabelas para isso no SQLite/PostgreSQL

3. SISTEMA ORIENTADO À AÇÃO
- Hoje: 'você tem 17 oportunidades abertas'
- Ideal: '3 oportunidades >R$50k sem follow-up há 4 dias com risco alto de perda'
- Proponha: feed operacional inteligente, motor de alertas, central de próximas ações
- Descreva UX: como seria a tela inicial de um vendedor nesse novo sistema?

4. CAMADA DE EVENTOS
- Proponha event sourcing parcial: quais eventos capturar, como armazenar, como processar
- Como detectar 'follow-up perdido' automaticamente? Qual a lógica?
- Como calcular 'tempo médio por etapa' por vendedor? Por pipeline?

5. QUALIDADE DE INSIGHTS
- Diferencie: insight superficial ('você perdeu 5 deals este mês') vs insight acionável ('você perde 80% dos deals quando não responde em 24h — há 3 oportunidades nessa situação agora')
- Como garantir que a IA só afirme o que os dados sustentam?
- Proponha camada de validação de insights antes de exibir ao usuário

6. GAMIFICAÇÃO INTELIGENTE
- Redesenhe o scoring para incentivar qualidade, não volume
- Proponha métricas de eficiência (conversão por etapa, velocidade de resposta, qualidade de follow-up)
- Identifique e elimine os loopholes do sistema atual

7. DIFERENCIAL COMPETITIVO
- O que torna esse sistema difícil de replicar?
- Quais dados acumulados ao longo do tempo viram inteligência proprietária?
- Como esse sistema pode ser posicionado como camada de inteligência sobre qualquer CRM?

8. ROADMAP TÉCNICO
- Quick wins (implementáveis em 1-2 semanas): lista priorizada
- Médio prazo (1-3 meses): melhorias de alto impacto
- Longo prazo (3-6 meses): mudanças arquiteturais
- Para cada item: esforço estimado, impacto esperado, dependências

9. NOVA ARQUITETURA CONCEITUAL
- Desenhe (em texto/ASCII) a nova arquitetura proposta
- Mostre como os módulos se relacionam
- Identifique onde cada problema atual é resolvido

Seja crítico, profundo, técnico e estratégico. Sem sugestões genéricas.

Salve em /opt/ploomes-analyst/AUDIT_F8_estrategia.md"

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_F8_estrategia.md" 2>>"$LOG"; then
    mark_done "$FASE"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

# ─────────────────────────────────────────────
# FASE 9 — Consolidação do relatório final
# ─────────────────────────────────────────────
FASE="FASE 9 — Consolidação do relatório final"
if ! check_done "$FASE"; then
  log "Iniciando: $FASE"
  PROMPT="Você é um arquiteto sênior consolidando a auditoria completa do CRM Ploomes Analyst.

Leia os seguintes arquivos de auditoria:
- /opt/ploomes-analyst/AUDIT_F2_backend.md
- /opt/ploomes-analyst/AUDIT_F3_database.md
- /opt/ploomes-analyst/AUDIT_F4_frontend.md
- /opt/ploomes-analyst/AUDIT_F5_api_integration.md
- /opt/ploomes-analyst/AUDIT_F6_coach_ai.md
- /opt/ploomes-analyst/AUDIT_F7_dashboards.md
- /opt/ploomes-analyst/AUDIT_F8_estrategia.md

Consolide em /opt/ploomes-analyst/AUDIT_FINAL.md:

# Estrutura do relatório final:

## 1. EXECUTIVE SUMMARY (1 página)
- Estado atual do sistema em 5 bullets
- Top 3 riscos críticos imediatos
- Top 3 oportunidades estratégicas
- Recomendação geral: o sistema está em que nível de maturidade?

## 2. PROBLEMAS CRÍTICOS (bloqueadores)
Lista todos os CRÍTICO de todas as fases, deduplicados e priorizados.

## 3. PROBLEMAS ALTOS
Lista todos os ALTO.

## 4. PROBLEMAS MÉDIOS E BAIXOS
Lista resumida.

## 5. ROADMAP CONSOLIDADO
- Semana 1-2 (quick wins)
- Mês 1-3 (alto impacto)
- Mês 3-6 (arquitetural)

## 6. EVOLUÇÃO ESTRATÉGICA RESUMIDA
- Nova arquitetura em 1 página
- Os 5 diferenciais competitivos

## 7. PRÓXIMOS 3 PASSOS CONCRETOS
Com código ou spec detalhada suficiente para implementar imediatamente.

Seja objetivo. Este relatório é para o dono do produto tomar decisões."

  if $CC < <(echo "$PROMPT") > "$PROJECT/AUDIT_FINAL.md" 2>>"$LOG"; then
    mark_done "$FASE"
    log "🎉 AUDITORIA COMPLETA. Relatório em $PROJECT/AUDIT_FINAL.md"
  else
    mark_error "$FASE" "claude -p retornou erro"
  fi
else
  log "⏭️  $FASE já concluída, pulando"
fi

log "=== Runner finalizado. Verifique $PROGRESS para status. ==="

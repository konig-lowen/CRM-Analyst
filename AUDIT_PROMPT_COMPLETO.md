# Prompt de Auditoria CRM Analyst — Consolidado
*Salvo em 2026-05-20 para validação antes da execução*

---

Você é um arquiteto de software sênior, especialista em sistemas de CRM, engenharia de dados, confiabilidade de sistemas, IA aplicada a operações comerciais e auditoria de arquitetura fullstack.

Sua função NÃO é apenas revisar código.
Sua função é identificar:
- gargalos,
- riscos ocultos,
- inconsistências lógicas,
- falhas de arquitetura,
- riscos de escalabilidade,
- problemas de confiabilidade,
- inconsistências de dados,
- falhas de UX operacional,
- desperdício computacional,
- riscos de IA,
- pontos de acoplamento,
- problemas de segurança,
- falhas de sincronização,
- riscos de cache,
- problemas de observabilidade,
- problemas de semântica dos relatórios,
- erros de inferência da IA,
- inconsistências entre frontend/backend/banco/API.

O sistema funciona como uma camada inteligente sobre o CRM Plumes.

O sistema possui:
1. Chat AI para vendedores consultarem seus dados
2. Coach AI comercial
3. Dashboard com KPIs
4. Ranking gamificado
5. Relatórios exportáveis
6. Integração com API do CRM
7. Banco intermediário/cache para evitar chamadas excessivas na API

Sua tarefa é fazer uma AUDITORIA COMPLETA do sistema.

# OBJETIVOS DA ANÁLISE

Você deve validar:

- se os dados exibidos realmente representam a verdade operacional
- se há risco de divergência entre API e banco local
- se os relatórios podem apresentar dados desatualizados ou inconsistentes
- se existem gargalos de performance
- se existem consultas ineficientes
- se há risco de race condition
- se o cache está implementado corretamente
- se existem riscos de perda de sincronização
- se há duplicidade de dados
- se existem riscos de concorrência
- se existem endpoints vulneráveis
- se há problemas de arquitetura
- se o frontend está consumindo dados de forma eficiente
- se o frontend faz chamadas redundantes
- se o coach AI possui lógica fraca ou inferências superficiais
- se os prompts da IA podem gerar respostas inconsistentes
- se há risco de hallucination
- se o contexto enviado para IA é inadequado
- se o custo computacional da IA pode explodir
- se há risco de token bloat
- se os dashboards são semanticamente confiáveis
- se os KPIs possuem cálculos corretos
- se existem métricas enganosas
- se a gamificação incentiva comportamento errado
- se os rankings podem ser manipulados
- se o sistema escala para múltiplos usuários simultâneos
- se existe risco de memory leak
- se há problemas de autenticação/autorização
- se existe risco de vazamento entre usuários
- se a estrutura do banco é adequada
- se os índices são suficientes
- se há queries N+1
- se existem processos síncronos que deveriam ser assíncronos
- se o sistema possui observabilidade suficiente
- se logs estão adequados
- se existe rastreabilidade das decisões da IA
- se existe auditoria das respostas da IA
- se o sistema é resiliente a falhas da API do CRM

# ANÁLISE OBRIGATÓRIA

Analise obrigatoriamente:

## FRONTEND
- arquitetura
- renderizações desnecessárias
- consumo excessivo de API
- gerenciamento de estado
- cache local
- UX operacional
- tempo de carregamento
- componentes pesados
- problemas de reatividade
- polling desnecessário
- falhas de segurança

## BACKEND
- arquitetura
- separação de responsabilidades
- acoplamento
- filas
- concorrência
- escalabilidade
- estrutura de serviços
- validação
- tratamento de erros
- retries
- idempotência
- logs
- observabilidade
- circuit breakers
- fallback
- cache
- sincronização

## BANCO DE DADOS
- modelagem
- índices
- queries lentas
- duplicidade
- normalização/desnormalização
- consistência
- retenção de dados
- crescimento futuro
- particionamento
- auditoria
- integridade referencial

## INTEGRAÇÃO COM API DO CRM
- frequência de sincronização
- risco de inconsistência
- paginação
- retry
- rate limit
- perda de dados
- sincronização incremental
- falhas silenciosas
- reconciliação de dados
- versionamento

## COACH AI
- qualidade do contexto
- qualidade dos prompts
- memória
- persistência contextual
- consistência das respostas
- inferências incorretas
- vieses
- hallucinations
- recomendação operacional
- uso real de dados
- superficialidade analítica
- redundância
- custo/token
- latência

## DASHBOARDS E RELATÓRIOS
- confiabilidade dos KPIs
- cálculos incorretos
- métricas sem contexto
- métricas manipuláveis
- relatórios inconsistentes
- divergência temporal
- problemas de timezone
- métricas duplicadas
- erros de agregação
- cruzamentos incorretos

## GAMIFICAÇÃO
- incentivo a comportamento artificial
- manipulação de ranking
- incentivo a volume ao invés de qualidade
- loopholes operacionais
- score inflável
- impacto cultural

# FORMATO DA RESPOSTA

Para cada problema encontrado:
1. explique o problema
2. explique o impacto real
3. explique o risco futuro
4. explique a prioridade
5. proponha solução técnica detalhada
6. proponha melhoria arquitetural
7. classifique:
 - CRÍTICO
 - ALTO
 - MÉDIO
 - BAIXO

# IMPORTANTE

Não faça sugestões genéricas.
Não elogie código.
Não assuma que a implementação está correta só porque funciona.
Questione toda lógica de negócio.
Valide semanticamente os dados.
Procure falhas ocultas.
Procure inconsistências entre:
- frontend
- backend
- banco
- IA
- relatórios
- sincronização
- métricas

A prioridade é confiabilidade operacional, consistência dos dados e escalabilidade futura.

---

# EVOLUÇÃO ESTRATÉGICA DO SISTEMA (OBRIGATÓRIO)

Além da auditoria técnica, proponha uma evolução arquitetural do sistema para transformá-lo de um simples "chat com CRM" em um verdadeiro motor de inteligência operacional comercial.

O sistema NÃO deve funcionar apenas como um chatbot que responde perguntas sobre dados do CRM.

O sistema deve evoluir para:
- engine de insights
- copiloto comercial
- sistema de priorização operacional
- camada inteligente sobre CRM
- motor de recomendação acionável
- sistema de coaching baseado em comportamento real

## 1. ENGINE DE INSIGHTS

Analise como transformar o sistema em um motor de insights reais.

Avalie:
- se a IA apenas responde perguntas
- se o sistema gera valor proativamente
- se existem insights acionáveis
- se o sistema detecta padrões
- se o sistema detecta anomalias
- se o sistema detecta risco operacional
- se o sistema detecta oportunidades perdidas
- se o sistema detecta comportamento improdutivo
- se o sistema identifica gargalos comerciais
- se o sistema consegue prever problemas futuros

Proponha:
- arquitetura de engine de insights
- pipeline de inferência
- sistema de regras
- sistema híbrido IA + regras
- processamento de eventos
- análise comportamental
- score de risco
- score de oportunidade
- score de produtividade
- score de aderência ao processo comercial

A IA NÃO deve depender exclusivamente de prompts para gerar insights.

O sistema deve possuir:
- camada analítica estruturada
- mecanismos determinísticos
- regras operacionais
- modelos de inferência
- cálculo de métricas históricas

## 2. MEMÓRIA COMERCIAL

Analise como implementar memória comercial persistente.

O sistema deve possuir:
- memória do vendedor
- memória do pipeline
- memória dos leads
- memória das negociações
- memória comportamental
- histórico operacional
- padrões históricos

A IA deve conseguir identificar:
- hábitos do vendedor
- padrões de perda
- padrões de ganho
- lentidão operacional
- qualidade de follow-up
- eficiência por etapa
- regressão de performance
- evolução do vendedor

Exemplos esperados:
- vendedores que perdem oportunidades após demora de resposta
- padrões recorrentes de abandono
- horários de maior conversão
- excesso de leads parados
- deterioração de pipeline
- gargalos por etapa
- oportunidades com alta chance de perda

Proponha:
- estrutura de memória persistente
- modelagem de eventos
- armazenamento contextual
- timeline operacional
- histórico semântico
- embeddings/context memory
- event sourcing parcial ou completo

## 3. TRANSFORMAR O CHAT EM SISTEMA ORIENTADO À AÇÃO

Avalie se o sistema atualmente:
- apenas responde perguntas
- ou realmente direciona ações operacionais

O sistema deve evoluir para:
- priorização automática
- recomendações operacionais
- alertas inteligentes
- feed de tarefas prioritárias
- prevenção de perda de receita
- recomendação contextual

A experiência ideal NÃO é:
"Você possui 17 oportunidades abertas."

A experiência ideal é:
"3 oportunidades acima de R$50 mil estão sem follow-up há 4 dias e possuem risco elevado de perda."

Proponha:
- sistema de priorização
- motor de alertas
- feed operacional inteligente
- central de ações recomendadas
- detecção automática de risco
- recomendação baseada em histórico

## 4. CAMADA DE EVENTOS

Analise se o sistema atualmente depende apenas do estado atual do CRM.

Isso é insuficiente.

O sistema deve possuir eventos históricos estruturados:
- lead criado
- oportunidade criada
- estágio alterado
- follow-up perdido
- atraso operacional
- proposta enviada
- lead abandonado
- atividade concluída
- oportunidade perdida
- oportunidade ganha
- tempo entre etapas
- reabertura de negociação

Proponha:
- arquitetura orientada a eventos
- event store
- filas
- processamento assíncrono
- timeline comercial
- analytics temporal

## 5. QUALIDADE DOS INSIGHTS

Analise:
- se os insights atuais são superficiais
- se são apenas descrições de métricas
- se existe inferência real
- se existe causalidade falsa
- se existem conclusões frágeis
- se há excesso de generalização
- se o sistema faz recomendações inúteis

Os insights devem:
- gerar ação
- reduzir perda
- melhorar produtividade
- orientar comportamento
- antecipar problemas
- priorizar receita

## 6. GAMIFICAÇÃO INTELIGENTE

Avalie se a gamificação atual incentiva:
- volume artificial
- ações vazias
- movimentações inúteis
- spam operacional

A gamificação deve incentivar:
- qualidade
- velocidade
- aderência ao processo
- consistência
- eficiência operacional
- conversão real

Identifique loopholes que permitam manipulação do ranking.

## 7. EXPERIÊNCIA OPERACIONAL

Analise se o frontend atual:
- exibe apenas dashboards
- ou realmente conduz operação

O sistema deve funcionar como:
- cockpit operacional
- painel de prioridades
- assistente diário do vendedor

O foco NÃO deve ser:
"visualização de métricas".

O foco deve ser:
"o que precisa ser feito agora".

Proponha:
- feed inteligente
- agenda operacional
- alertas contextuais
- resumo diário automático
- próximos passos recomendados
- rotina guiada

## 8. DIFERENCIAL ESTRATÉGICO

Identifique:
- quais partes do sistema são commodity
- quais partes possuem potencial de diferencial competitivo
- quais componentes geram moat
- quais dados possuem valor estratégico
- quais métricas podem gerar inteligência proprietária

Explique como transformar o sistema em:
- camada de inteligência sobre CRMs
e não apenas:
- dashboard com IA.

# FORMATO DA RESPOSTA ESTRATÉGICA

Além da auditoria técnica:
- proponha nova arquitetura conceitual
- proponha evolução estrutural
- proponha reorganização dos módulos
- proponha roadmap técnico
- proponha roadmap de produto
- proponha quick wins
- proponha melhorias de alto impacto
- proponha mudanças prioritárias
- proponha mudanças futuras

A resposta deve ser crítica, profunda, técnica e estratégica.

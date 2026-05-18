# TEST_REPORT — Ploomes Analyst + Coach AI

Gerado em: 2026-05-10T04:27:09Z

## Auditoria 30/90/180 dias (validação direta via API Ploomes)
Definições:
- Deals ganhos = StatusId=2, filtro por FinishDate >= start
- Deals perdidos = StatusId=3, filtro por FinishDate >= start
- Interações = InteractionRecords, filtro por Date >= start
- Tasks (para cumprir regra de filtro de data): open = Finished=false AND DateTime >= start; overdue = open AND DateTime < now

| janela | start | won | won_sum | lost | lost_sum | interactions | tasks_open | tasks_overdue |
|---|---|---|---|---|---|---|---|---|
| 30d | 2026-04-10T04:26:46Z | 26 | 523576.95 | 223 | 1015240.94 | 1865 | 49 | 33 |
| 90d | 2026-02-09T04:26:53Z | 65 | 1079885.43 | 559 | 2210720.09 | 5602 | 61 | 45 |
| 180d | 2025-11-11T04:26:58Z | 141 | 1645083.2 | 979 | 3920160.48 | 8346 | 69 | 53 |

### Divergências observadas (via /api/chat)
- Em 90d e 180d, o modelo frequentemente confundiu **tasks_open** com **tasks_overdue** ao adicionar `DateTime le end` no filtro e/ou estimar vencidas a partir do total. A validação direta indica:
  - 90d: open=61, overdue=45
  - 180d: open=69, overdue=53
  - (o /api/chat retornou 45 e 53 como “pendentes”, que são na prática as vencidas dentro da janela)

## Mudanças de performance implementadas (server.js)
- **Bloqueio de fetch sem filtro de data** para /Deals, /Tasks, /InteractionRecords: retorna erro “Filtro de data obrigatório”.
- **Cache em memória (60s)** para chamadas GET repetidas à API Ploomes (reduz latência e rate-limit).
- **Fetch enxuto para o modelo**: retorna amostra (até 20) + `@odata.count` (quando disponível) + agregados `{count, sumAmount}` (Deals) sem despejar listas gigantes.
- **Prompts atualizados**: forçam janelas 30/90/180 em perguntas amplas + preferência por agregações/top N.

## Resultados — 30 testes Analista
- HTTP OK: 28/30
- Latência média: 50.06s | p95: 95.59s
- Nota média (heurística 1-5): 4.36 | distribuição: {3: 9, 5: 19}
- Validações numéricas (10 checks): 3/8 passaram

| idx | pergunta | fetch? | tempo_s | nota | gaps |
|---|---|---|---|---|---|
| 1 | Auditoria 30d. Use EXATAMENTE: start=2026-04-10T03:55:51Z end=2026-05-… | sim | 16.96 | 3 | validação numérica falhou |
| 2 | Auditoria 90d. Use EXATAMENTE: start=2026-02-09T03:55:51Z end=2026-05-… | sim | 12.24 | 3 | validação numérica falhou |
| 3 | Auditoria 180d. Use EXATAMENTE: start=2025-11-11T03:55:51Z end=2026-05… | não | 0.0 | 1 | erro http/timeout |
| 4 | Quantos InteractionRecords existem desde 2026-04-10T03:55:51Z (UTC)? N… | não | 0.0 | 1 | erro http/timeout |
| 5 | Quantas Tasks abertas desde 2026-04-10T03:55:51Z (Finished eq false AN… | sim | 15.1 | 5 | — |
| 6 | Quantas Tasks vencidas desde 2026-04-10T03:55:51Z (Finished eq false A… | sim | 21.25 | 5 | — |
| 7 | Deals ganhos desde 2026-04-10T03:55:51Z (StatusId=2; FinishDate ge 202… | sim | 24.24 | 3 | validação numérica falhou |
| 8 | Deals perdidos desde 2026-04-10T03:55:51Z (StatusId=3; FinishDate ge 2… | sim | 29.81 | 3 | validação numérica falhou |
| 9 | Deals ganhos desde 2026-02-09T03:55:51Z (StatusId=2; FinishDate ge 202… | sim | 32.04 | 5 | — |
| 10 | Deals perdidos desde 2026-02-09T03:55:51Z (StatusId=3; FinishDate ge 2… | sim | 29.86 | 3 | validação numérica falhou |
| 11 | Resumo executivo dos últimos 30 dias: ganhos vs perdas, principais ris… | sim | 39.6 | 5 | — |
| 12 | Quais são os gargalos mais prováveis no funil olhando para perdas muit… | sim | 62.19 | 5 | — |
| 13 | Sugira uma rotina semanal baseada em dados (cadência, follow-up, organ… | sim | 64.24 | 5 | — |
| 14 | Se eu tiver muitas tasks vencidas, qual o impacto típico em vendas B2B… | sim | 62.57 | 5 | — |
| 15 | Como segmentar o diagnóstico por vendedor sem puxar dados gigantes? De… | sim | 91.93 | 5 | — |
| 16 | Crie um plano de melhoria de win rate em 4 semanas com métricas acompa… | sim | 83.42 | 5 | — |
| 17 | Explique como interpretar volume alto de interações com win rate baixo… | sim | 86.38 | 5 | — |
| 18 | Proponha um dashboard mínimo (5 KPIs) para acompanhar diariamente. | sim | 69.0 | 5 | — |
| 19 | Checklist para qualificação (SPIN/MEDDIC) alinhado ao CRM. | não | 27.46 | 3 | não executou fetches (ou fetchData=null) |
| 20 | Que perguntas eu deveria fazer ao time para explicar uma taxa de perda… | sim | 72.47 | 5 | — |
| 21 | Sugira como priorizar pipeline parado (sem buscar tudo) usando filtros… | sim | 84.14 | 5 | — |
| 22 | Como reduzir tempo de resposta do analista: o que buscar primeiro e o … | sim | 70.75 | 5 | — |
| 23 | O que significa ter muitos deals com Amount=0 e como corrigir governan… | sim | 65.53 | 5 | — |
| 24 | Como medir efetividade de interações por tipo (visita vs ligação etc.)… | não | 15.22 | 3 | não executou fetches (ou fetchData=null) |
| 25 | Monte uma hipótese de causa-raiz para perdas altas e como validar com … | sim | 89.45 | 5 | — |
| 26 | Sugira ações práticas para melhorar follow-up e reduzir perdas por fal… | sim | 98.58 | 5 | — |
| 27 | Como diferenciar perda por preço vs perda por urgência/qualificação no… | sim | 54.87 | 5 | — |
| 28 | Como usar tasks para aumentar disciplina comercial? | sim | 62.05 | 5 | — |
| 29 | Quais sinais de churn/problema operacional aparecem nas interações? | não | 8.44 | 3 | não executou fetches (ou fetchData=null) |
| 30 | Estruture um relatório mensal para diretoria (tópicos, gráficos, decis… | não | 11.99 | 3 | não executou fetches (ou fetchData=null) |

### Auditoria detalhada — 10 validações numéricas (analista)
- Q01: FAIL | lat=16.96s | Auditoria 30d. Use EXATAMENTE: start=2026-04-10T03:55:51Z end=2026-05-10T03:55:5
  - tasks_overdue_count: model=4 vs gt=33
- Q02: FAIL | lat=12.24s | Auditoria 90d. Use EXATAMENTE: start=2026-02-09T03:55:51Z end=2026-05-10T03:55:5
  - tasks_open_count: model=45 vs gt=61
- Q05: OK | lat=15.1s | Quantas Tasks abertas desde 2026-04-10T03:55:51Z (Finished eq false AND DateTime
- Q06: OK | lat=21.25s | Quantas Tasks vencidas desde 2026-04-10T03:55:51Z (Finished eq false AND DateTim
- Q07: FAIL | lat=24.24s | Deals ganhos desde 2026-04-10T03:55:51Z (StatusId=2; FinishDate ge 2026-04-10T03
  - won_count: model=None vs gt=26
  - won_sum: model=None vs gt=523576.94999999995
- Q08: FAIL | lat=29.81s | Deals perdidos desde 2026-04-10T03:55:51Z (StatusId=3; FinishDate ge 2026-04-10T
  - lost_count: model=None vs gt=223
  - lost_sum: model=None vs gt=1015240.9400000002
- Q09: OK | lat=32.04s | Deals ganhos desde 2026-02-09T03:55:51Z (StatusId=2; FinishDate ge 2026-02-09T03
- Q10: FAIL | lat=29.86s | Deals perdidos desde 2026-02-09T03:55:51Z (StatusId=3; FinishDate ge 2026-02-09T
  - lost_count: model=None vs gt=559
  - lost_sum: model=None vs gt=2210720.09

## Resultados — 30 testes Coach AI
- HTTP OK: 30/30
- Latência média: 11.92s | p95: 29.52s
- Nota média (heurística 1-5): 3.33 | distribuição: {2: 5, 3: 16, 4: 3, 5: 6}

| idx | pergunta | fetch? | tempo_s | nota | gaps |
|---|---|---|---|---|---|
| 1 | Estou perdendo muitos deals. O que eu mudo na minha abordagem esta sem… | não | 3.64 | 2 | não terminou com pergunta; poucas ações práticas explícitas |
| 2 | Tenho muitas tarefas vencidas e me sinto sobrecarregado. Como reorgani… | não | 24.78 | 5 | — |
| 3 | Minha taxa de perda é alta. Me faça perguntas para entender a causa e … | não | 4.43 | 5 | — |
| 4 | Quero aumentar win rate. Me ajude a montar um roteiro de ligação (SPIN… | não | 8.99 | 5 | — |
| 5 | Como lidar com objeção de preço em compressores B2B sem virar desconto… | não | 14.85 | 3 | não terminou com pergunta |
| 6 | Me ajude a criar urgência sem ser agressivo. | não | 7.5 | 3 | não terminou com pergunta |
| 7 | Eu procrastino follow-up. Me dê um sistema simples e cobravel. | não | 22.25 | 4 | poucas ações práticas explícitas |
| 8 | Eu fecho bem quando chego no decisor, mas chego pouco. Como melhorar a… | não | 9.18 | 3 | não terminou com pergunta |
| 9 | Minhas interações são muitas mas não avançam etapa. O que isso indica? | não | 5.35 | 2 | não terminou com pergunta; poucas ações práticas explícitas |
| 10 | Quero um desafio: 7 dias para aumentar qualidade das conversas. Me gui… | não | 13.42 | 3 | não terminou com pergunta |
| 11 | Tenho medo de pedir o próximo passo. Como treinar fechamento consultiv… | não | 4.88 | 2 | não terminou com pergunta; poucas ações práticas explícitas |
| 12 | Estou com pipeline inflado e parado. Como priorizar? | não | 4.47 | 3 | não terminou com pergunta |
| 13 | Como usar Challenger Sale nesse mercado industrial? | não | 16.24 | 3 | não terminou com pergunta |
| 14 | Faça coaching baseado em dados dos últimos 30 dias (se precisar, busqu… | sim | 19.86 | 3 | não terminou com pergunta |
| 15 | Quero preparar uma reunião de diagnóstico com cliente grande. Me ajude… | não | 10.63 | 3 | não terminou com pergunta |
| 16 | Eu perco muito na etapa de proposta. O que muda na proposta e no follo… | não | 5.4 | 3 | não terminou com pergunta |
| 17 | Me ajude a melhorar qualificação (MEDDIC) sem burocracia. | não | 5.25 | 3 | não terminou com pergunta |
| 18 | Como aumentar número de visitas/reuniões efetivas? | não | 5.35 | 3 | não terminou com pergunta |
| 19 | Como lidar com concorrência e comparação de preço? | não | 31.26 | 5 | — |
| 20 | Como criar cadência de prospecção para locação/manutenção? | não | 17.89 | 5 | — |
| 21 | Quero feedback duro: quais hábitos te parecem fracos de um vendedor qu… | sim | 13.19 | 4 | poucas ações práticas explícitas |
| 22 | Simule uma conversa de coaching comigo (você pergunta, eu respondo). | não | 3.82 | 2 | não terminou com pergunta; poucas ações práticas explícitas |
| 23 | Me dê 3 frases para pedir indicação dentro de uma conta industrial. | não | 7.62 | 4 | poucas ações práticas explícitas |
| 24 | Como me proteger de perder por 'sumiu'? | não | 13.68 | 5 | — |
| 25 | Como negociar prazo e condições sem corroer margem? | não | 28.09 | 3 | não terminou com pergunta |
| 26 | Me ajude a planejar a semana com 3 blocos (prospecção, follow-up, visi… | não | 6.19 | 3 | não terminou com pergunta |
| 27 | Eu tenho muitos leads pequenos. Como não lotar o funil com lixo? | não | 9.59 | 3 | não terminou com pergunta |
| 28 | Eu tenho poucos leads grandes. Como gerar oportunidades maiores? | sim | 17.65 | 3 | não terminou com pergunta |
| 29 | Quero melhorar disciplina no CRM (Amount, etapas, datas). Como impleme… | não | 17.77 | 3 | não terminou com pergunta |
| 30 | Feche com uma pergunta para eu responder: qual meu principal gargalo h… | não | 4.38 | 2 | não terminou com pergunta; poucas ações práticas explícitas |

## Score geral
- Média geral (60 testes, heurística 1-5): 3.83


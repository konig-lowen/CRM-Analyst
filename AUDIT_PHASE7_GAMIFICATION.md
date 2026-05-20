# AUDIT_PHASE7 — Gamificação / Ranking
**Data:** 2026-05-20  
**Auditor:** Jarvis (subagente)  
**Arquivos analisados:** `server.js` (funções `computeRanking`, `computeDashboard`), `ranking.html`

---

## O que existe

O sistema **tem gamificação implementada** na forma de um ranking de pontuação (ScoreCRM) com:
- Leaderboard mensal por vendedor
- Pódio visual (Top 3 com medalhas 🥇🥈🥉)
- Breakdown de pontos por categoria

### Tabela de Pontuação (atual)

| Evento | Pontos |
|--------|--------|
| Deal ganho | +10 |
| Interação registrada | +1 |
| Visita ou reunião (TypeId 2 ou 5) | +2 adicional (+3 total) |
| Tarefa concluída no prazo | +3 |
| Tarefa vencida em aberto | -2 |
| Deal sem atualização >30d | -1 (cap -20/vendedor) |
| Semana usando Coach AI | +2 |

---

## Problemas Encontrados

---

**[🔴] Score manipulável por volume de interações sem qualidade**
- **Descrição:** Cada interação registrada vale +1 ponto, sem verificação de qualidade, duração, outcome ou funil. Um vendedor pode registrar 50 "ligações rápidas" sem progressão real de deal e ganhar +50 pontos. Visitas e reuniões (TypeId 2 e 5) valem +3 por ocorrência — também sem outcome.
- **Impacto real:** Vendedor que registra muito bate ranking consistentemente sobre quem que fecha mais mas registra menos. O ranking deixa de refletir desempenho real.
- **Risco futuro:** Cultura de "registro para pontos" vs "fechamento de negócios". Time pode aprender a manipular o sistema em vez de melhorar o processo.
- **Solução técnica:** 
  1. Adicionar teto de interações pontuáveis por dia/semana por vendedor (ex: máx 5 interações/dia contam para score)
  2. Bonificar interações **vinculadas a deals** que progrediram de etapa no mesmo período
  3. Introduzir métricas de qualidade: % de deals com interação que avançaram de stage

---

**[🔴] Ranking não pondera valor dos deals (only count, not value)**
- **Descrição:** Deal ganho = +10 pontos, independentemente do valor. Um deal de R$500 vale o mesmo que um de R$500.000. Vendor que fecha muitos tickets pequenos pode rankear acima de quem fecha menos negócios mas com maior valor.
- **Impacto real:** Incentiva volume sobre qualidade. Vendedores do funil de manutenção/renovação (tickets pequenos, alto volume) vão sistematicamente superar vendedores de projetos (tickets grandes, menor volume) sem que isso reflita contribuição real à receita.
- **Risco futuro:** Desvio de comportamento: vendedores vão preferir fechar deals fáceis/menores para inflar score em vez de trabalhar oportunidades complexas de alto valor.
- **Solução técnica:**
  1. Pontuação por valor: `+1 ponto por R$10.000 fechados` (calibrar conforme ticket médio do negócio)
  2. Ou: bônus por atingir ticket mínimo (ex: +5 extra para deals > R$50.000)
  3. Separar ranking por "volume" e "receita" para complementar

---

**[🟠] Ranking compara funis com naturezas diferentes sem ponderação**
- **Descrição:** O ScoreCRM agrega deals ganhos de todos os funis (**exceto os explicitamente excluídos**). Vendedor do funil "Projetos" (ciclo 90d, ticket alto, poucos deals) é comparado diretamente com vendedor do funil "Serviços" (ciclo 15d, ticket baixo, muitos deals). O vendedor de Projetos terá sistematicamente pontuação menor.
- **Impacto real:** Ranking injusto e desmotivador para vendedores de funis mais complexos. Pode gerar percepção de que o sistema é "rigged".
- **Risco futuro:** Rotatividade de vendedores de produtos/funis mais complexos, que são geralmente os mais estratégicos.
- **Solução técnica:**
  1. Calcular rankings **por funil** e agregar com peso proporcional ao ciclo médio do funil
  2. Ou criar rankings separados por funil/categoria de produto
  3. Normalizar por meta: pontuação como % de atingimento da meta individual, não valor absoluto

---

**[🟠] Incentivo cultural: atividade > resultado**
- **Descrição:** A distribuição de pontos atual favorece atividade (interações = +1 cada, tarefas no prazo = +3) sobre resultado (deal ganho = +10). Um vendedor que faz 50 interações e 10 tarefas no prazo ganha 80 pontos — equivalente a 8 deals fechados. O sinal enviado ao time é que "se mover" equivale a "fechar".
- **Impacto real:** Em contexto B2B industrial (VetorV), o relacionamento e a atividade têm valor real, mas o resultado final é a receita. O peso atual pode criar a cultura errada.
- **Risco futuro:** KPIs de atividade sobem, revenue estagna. Time se sente bem-sucedido sem bater meta.
- **Solução técnica:**
  1. Rebalancear pesos: deal ganho = +25, interação = +0.5 (capped), tarefa no prazo = +2
  2. Adicionar bônus por meta atingida: +50 pontos ao bater 100% da meta mensal
  3. Multa proporcional por deals perdidos (hoje: perdas não pontuam negativamente!)

---

**[🟠] Deals perdidos não penalizam — assimetria de incentivo**
- **Descrição:** No score atual, perder um deal não tem impacto negativo. Só há penalidade por tarefas vencidas (-2) e deals parados (-1). Isso cria assimetria: fechar vale +10, perder vale +0. Vendedor pode acumular 100 perdas sem impacto no score enquanto fecha 3 deals para 30 pontos.
- **Impacto real:** Score não reflete eficiência de conversão, apenas volume de fechamentos. Um vendedor com 3% de win rate (3 ganhos, 97 perdas) pontua igual a um com 75% (3 ganhos, 1 perda).
- **Risco futuro:** Ranking deixa de ser um indicador confiável de desempenho comercial para gestão.
- **Solução técnica:**
  1. Introduzir fator de conversão no score: multiplica pontuação base pelo percentile de win rate do vendedor vs média do time
  2. Ou: bônus por win rate acima da média (+10 pontos/mês se win rate > média do time)

---

**[🟡] Bônus de Coach AI cria incentivo artificial**
- **Descrição:** +2 pontos por semana usando o Coach AI. O sistema verifica semanas distintas (`COUNT(DISTINCT strftime('%Y-%W', ...))`) — então não é manipulável por múltiplas sessões no mesmo dia. Mas a métrica incentiva uso do coach mesmo sem necessidade real, para ganhar pontos no ranking.
- **Impacto real:** Baixo no curto prazo. Pode inflar métricas de uso do Coach AI artificialmente.
- **Risco futuro:** Métricas de "engajamento com o Coach" ficam infladas pela gamificação, não pelo valor real da ferramenta.
- **Solução técnica:** Substituir por bônus baseado em outcome: +2 pontos se usou coach E fechou deal na mesma semana. Ou remover o bônus e medir adoção do coach separadamente.

---

**[🟡] Período do ranking fixo em mês/ano UTC sem comunicação clara**
- **Descrição:** O ranking exibe "Mês atual" como padrão, calculado em UTC. As opções "Trimestre" e "Ano" aparecem no select mas estão marcadas como `(placeholder)` — não implementadas. O usuário pode selecionar essas opções e não obterá dados diferentes.
- **Impacto real:** Confusão de usuário ao selecionar trimestre/ano e ver o mesmo dado.
- **Solução técnica:** Remover opções não implementadas do select até que estejam prontas, ou implementar os filtros.

---

**[🟡] Ranking não considera maturidade/tempo no cargo**
- **Descrição:** Vendedor novo (primeiro mês) é rankeado contra vendedor veterano com carteira estabelecida e pipeline cheio. A comparação é diretamente desfavorável ao novo.
- **Impacto real:** Desmotivação e turnover precoce de vendedores em ramp-up.
- **Solução técnica:** Criar categoria separada para vendedores com < 90 dias ou calcular score por % de meta individual atingida (equalizando pela meta, não pela pontuação absoluta).

---

## Sumário de Riscos

| Severidade | Problema | Ação |
|------------|----------|------|
| 🔴 | Score manipulável por volume de interações | Teto diário + qualidade de interação |
| 🔴 | Ranking por count, não por valor | Pontuação proporcional ao valor |
| 🟠 | Funis diferentes sem ponderação | Rankings por funil ou normalização por meta |
| 🟠 | Atividade > resultado na distribuição de pontos | Rebalancear pesos |
| 🟠 | Deals perdidos não penalizam | Fator de win rate no score |
| 🟡 | Bônus Coach AI artificial | Substituir por outcome-based |
| 🟡 | Opções de período não implementadas | Remover ou implementar |
| 🟡 | Não considera maturidade do vendedor | Categoria ramp-up ou % de meta |

---

## Impacto Cultural — Avaliação

O sistema atual **incentiva comportamento ativo e organizado** (registrar interações, cumprir tarefas, usar o coach), o que é **positivo** como baseline. Para um time que historicamente não seguia processos de CRM, esse estágio inicial faz sentido.

O risco maior é a **transição para o próximo nível**: quando o time já adotar o processo, o ranking atual vai começar a produzir distorções. O recomendado é preparar a versão 2.0 do score (baseado em receita gerada + % de meta + qualidade de processo) antes que o time amadureça e o score atual perca credibilidade.

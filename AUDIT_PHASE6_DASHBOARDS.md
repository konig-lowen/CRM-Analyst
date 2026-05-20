# AUDIT_PHASE6 — Dashboards e Relatórios
**Data:** 2026-05-20  
**Auditor:** Jarvis (subagente)  
**Arquivos analisados:** `server.js`, `dashboard.html`, `ranking.html`, `reports.html`

---

## Resumo Executivo

O sistema de dashboards é funcional e bem estruturado. Os cálculos centrais (win rate, ciclo de vendas, ticket, pipeline velocity) estão **matematicamente corretos**. Os maiores riscos residem em: mistura de janelas temporais distintas no dashboard principal, ausência de exportação CSV/PDF do dashboard (apenas relatório HTML executivo), e o ScoreCRM exposto ao usuário sem período explícito.

---

## Fórmulas Auditadas

### Win Rate
```
winRate = won / (won + lost) * 100
```
✅ Correto. Usa apenas ganhos + perdidos (exclui abertos). Arredondado a 1 casa decimal no cálculo por funil/owner, 2 no endpoint histórico.

**Inconsistência menor:** `ploomesGetDealsOwnerAggregates` usa `.toFixed(1)`, enquanto o endpoint `/api/reports/:userId` (histórico 6m) usa `.toFixed(2) + '%'` → diferença de precisão entre telas.

### Ciclo de Vendas
```
cicloMedio = mean(FinishDate - CreateDate) em dias
```
✅ Correto. Usa `Math.round((fd - cd) / (1000 * 86400))`. Filtra ciclos negativos (`days >= 0`).

**Risco:** não filtra ciclos outliers (ex: deal registrado retroativamente com ciclo de 2 anos distorce a média). Nenhum cap ou detecção de anomalia.

### Ticket Médio
```
ticketMedia = mean(Amount) dos deals ganhos (Amount > 0)
ticketMediana = median(Amount) dos deals ganhos
```
✅ Correto. Exclui deals ganhos sem valor do cálculo (Amount === 0 ou null). Ambas média e mediana calculadas.

**Observação:** `ticketMedia` inclui todos os deals ganhos com Amount > 0, mas deals ganhos com valor zero são contabilizados como ganhos no `won` counter — causando **denominador inflado** no win rate quando existem ganhos sem valor cadastrado.

### Pipeline Velocity
```
pipelineVelocity = (won * ticketMedia * winRate/100) / cicloMedio
```
✅ Fórmula padrão de mercado. Implementada corretamente.

---

## Problemas Encontrados

---

**[🟠] Mistura de janelas temporais no Dashboard Principal**
- **Descrição:** `computeDashboard` usa **dois períodos distintos sem sinalização clara** ao usuário:
  - `dealsWon` e `dealsLost` → filtro por `FinishDate >= início do mês UTC`
  - `interactions30` → últimos 30 dias corridos (não respeita início do mês)
  - `tarefasAbertas` → sem período (todas as tarefas abertas, sem limite temporal)
  - `staleDeals` → corte fixo de 30 dias (pode não coincidir com início do mês)
  - O card "Interações" usa 30d, mas o "Ganhos" usa mês atual — numa segunda-feira dia 3, "30d de interações" e "ganhos do mês" apontam para janelas muito diferentes sem aviso.
- **Impacto real:** O usuário interpreta todos os cards como "do mês" e toma decisões com base em comparações incoerentes.
- **Risco futuro:** Conforme o sistema escalar para relatórios comparativos, a mistura de janelas vai gerar anomalias difíceis de rastrear.
- **Solução técnica:** Padronizar todas as métricas do dashboard para uma única janela (mês atual OU últimos 30 dias), comunicar explicitamente no frontend qual período cada card usa, ou separar visualmente em seções "Mês atual" vs "Últimos 30 dias".

---

**[🟠] ScoreCRM sem período explícito na UI**
- **Descrição:** O ScoreCRM exibido no dashboard (`scorecrm`) combina métricas de períodos diferentes:
  - Ganhos do mês (`dealsWon` filtrado por `FinishDate >= startMonth`)
  - Interações dos últimos 30d (`interactions30` filtrado por `start30dIso`)
  - Tarefas sem prazo temporal consistente
  - Bônus de coach usando semanas distintas do mês
  O número aparece para o usuário como "Score CRM" sem nenhuma explicação de período ou metodologia.
- **Impacto real:** Vendedor não consegue reproduzir ou questionar seu score. Score pode variar do dia 1 para o dia 2 do mês por conta das interações rolantes (30d) sem que nada tenha acontecido.
- **Risco futuro:** Desmotivação e desconfiança no score quando vendedor percebe que ele "mudou sozinho".
- **Solução técnica:** (1) Definir uma janela única para o ScoreCRM (início do mês UTC). (2) Exibir tooltip ou painel de breakdown mostrando de onde vieram os pontos. (3) Versionar o score: salvar score calculado em DB ao final do mês para histórico.

---

**[🟡] Win Rate inconsistente entre telas**
- **Descrição:** A mesma métrica win rate é calculada com precisões diferentes:
  - `ploomesGetDealsOwnerAggregates` → `.toFixed(1)` (ex: "42.5")
  - `/api/reports/:userId` histórico 6m → `.toFixed(2) + '%'` (ex: "42.50%")
  - `/api/reports/ploomes/:ploomesUserId` → `.toFixed(2) + '%'`
  O formato também muda: número puro vs string com `%`.
- **Impacto real:** Menor, mas confuso para integrações e para o usuário se comparar telas.
- **Risco futuro:** Parsing de string "42.50%" como número vai gerar `NaN` em qualquer integração futura.
- **Solução técnica:** Centralizar em uma função `formatWinRate(value)` que retorna sempre número puro. A formatação para exibição (`%`) deve ficar só no frontend.

---

**[🟡] Denominador do Win Rate inclui deals ganhos sem valor**
- **Descrição:** Deals ganhos com `Amount = 0` ou `Amount = null` são contados no `won` counter (e portanto no denominador do win rate), mas excluídos do cálculo de ticket médio. O win rate fica inflado em relação ao ticket real.
  - Linha relevante: `if (r.Amount && r.Amount > 0) byOwner[oid].amounts.push(...)` — só Amount > 0 vai para ticket, mas todos StatusId=2 incrementam `won`.
- **Impacto real:** Win rate aparece correto, mas o pipeline velocity (que usa `ticketMedia * winRate * won`) fica subestimado quando há muitos ganhos sem valor cadastrado.
- **Risco futuro:** Em funis com muitos deals sem preenchimento de valor, o pipeline velocity pode ser zero ou muito baixo mesmo com bom volume de fechamentos.
- **Solução técnica:** Separar wins com valor (`wonsWithAmount`) de wins totais. Usar `wonsWithAmount` para ticket e velocity; manter `won` total para win rate. Documentar a distinção no tooltip.

---

**[🟡] Ciclo de vendas sem filtro de outliers**
- **Descrição:** `cicloMedio` é a média aritmética de todos os ciclos `>= 0`. Um deal registrado com CreateDate histórica antiga (ex: oportunidade de 2 anos) inflaciona o ciclo médio sem aviso. Não há cap nem detecção de outlier.
- **Impacto real:** Ciclo médio pode aparecer como 180 dias quando a maioria dos deals fecha em 30, por conta de 1-2 registros atípicos.
- **Risco futuro:** Coach AI usa o ciclo médio como referência ("deals esfriando") — valores distorcidos geram alertas incorretos.
- **Solução técnica:** Usar mediana para ciclo (já calculada para ticket, fácil de replicar) ou aplicar IQR para remover outliers antes de calcular a média. Expor ambos (média e mediana) no dashboard com tooltip explicando a diferença.

---

**[🟡] Relatório exportável diverge do dashboard**
- **Descrição:** O relatório HTML executivo (`/api/admin/generate-report`) lê dados do warehouse SQLite (`mv_conversion`, `mv_revenue`), enquanto o dashboard (`/api/dashboard`) faz fetch em tempo real da API Ploomes com filtros distintos. Duas fontes de verdade:
  - Warehouse é atualizado periodicamente (job de sync)
  - Dashboard é sempre live da API
  Um relatório gerado às 09h pode divergir do dashboard às 09h02 se houve sync entre os dois momentos.
- **Impacto real:** Gestor exporta relatório com número diferente do que está vendo na tela. Credibilidade comprometida.
- **Risco futuro:** Auditoria externa ou questionamento de vendedor pode expor a inconsistência.
- **Solução técnica:** O relatório exportável deve usar os mesmos dados do dashboard (live da API) ou o dashboard deve usar o warehouse — consistência entre as duas fontes. Se manter dual, adicionar watermark no relatório com "Dados do warehouse em [timestamp do último sync]" e comparar com "Dashboard live em [timestamp]".

---

**[🟡] Timezone: UTC no backend, sem ajuste para GMT-3 no frontend**
- **Descrição:** O backend usa `Date.UTC(...)` e `new Date().getUTCFullYear()` consistentemente — correto. Mas as datas são enviadas ao frontend como ISO strings sem timezone hint (ex: `"2026-05-20T03:00:00.000"`). O frontend exibe diretamente sem conversão. Para um usuário em GMT-3, "início do mês" no servidor é `2026-05-01T00:00:00 UTC`, que equivale a `2026-04-30T21:00:00 BRT` — o mês "começa" 3h antes da meia-noite local.
  - Impacto prático: deals fechados entre 21h e 23h59 do dia 30 de abril (GMT-3) podem entrar nas métricas de maio.
- **Impacto real:** Pequeno em volume, mas pode confundir vendedor que fechou um deal na noite do dia 30 e não o vê no mês correto.
- **Risco futuro:** Em análises de metas mensais, o primeiro e último dia do mês podem ter contagem incorreta.
- **Solução técnica:** Definir explicitamente o timezone de referência (GMT-3 = América/Sao_Paulo). Usar `Intl.DateTimeFormat` no frontend para exibir datas convertidas. No backend, calcular `startMonth` em GMT-3 (UTC-3): `new Date(Date.UTC(year, month-1, 1, 3, 0, 0))`.

---

**[🟢] Funis excluídos corretamente**
- **Descrição:** Funil Prospecção e Manutenção da Carteira são explicitamente excluídos das análises de conversão e receita. Há alertas de data quality quando ganhos históricos aparecem no Funil Prospecção. `INACTIVE_PIPELINE_IDS` é aplicado consistentemente nos filtros.
- **Status:** Correto. Sem ação necessária.

---

**[🟢] Agregação: média vs soma**
- **Descrição:** Não foram encontrados erros de agregação (soma onde deveria ser média). `ticketMedia` usa mean corretamente, `ticketMediana` usa mediana. `cicloMedio` usa mean (com a ressalva de outliers já documentada).
- **Status:** Correto. Sem ação necessária.

---

## Sumário de Riscos

| Severidade | Problema | Impacto |
|------------|----------|---------|
| 🟠 | Mistura de janelas temporais no dashboard | Decisões baseadas em dados de períodos incompatíveis |
| 🟠 | ScoreCRM sem período explícito na UI | Desconfiança e desmotivação do time |
| 🟡 | Win rate inconsistente entre telas | Confusão e bugs em integrações futuras |
| 🟡 | Denominador inflado no win rate | Pipeline velocity subestimado |
| 🟡 | Ciclo de vendas sem filtro de outliers | Métricas distorcidas por registros atípicos |
| 🟡 | Relatório exportável diverge do dashboard | Credibilidade comprometida |
| 🟡 | Timezone UTC vs GMT-3 | Deals do fim do dia podem entrar no mês errado |
| 🟢 | Funis excluídos corretamente | OK |
| 🟢 | Agregação média vs soma | OK |

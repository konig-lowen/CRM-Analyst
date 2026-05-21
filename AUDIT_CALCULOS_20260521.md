# Auditoria Técnica — Cálculos e Indicadores CRM Ploomes Analyst
**Data:** 2026-05-21  
**Auditor:** Subagente Técnico  
**Escopo:** server.js + scripts/sync_warehouse.js + warehouse.db

---

## SUMÁRIO EXECUTIVO

| # | Severidade | Achado |
|---|-----------|--------|
| 1 | 🔴 CRÍTICO | Pipeline Velocity com fórmula errada (double-counting) |
| 2 | 🔴 CRÍTICO | Dois algoritmos diferentes para Hygiene Score (warehouse vs API) |
| 3 | 🟡 MÉDIO | win_rate retornado como Number em alguns paths e String "%" em outros |
| 4 | 🟢 INFO | Claude/Haiku **não** é usado nos cálculos numéricos — só no chat |
| 5 | 🟢 INFO | Fórmulas de win_rate, mediana, stale_count validadas — corretas |

**Bugs matemáticos confirmados: 2**  
**Inconsistências de tipo/formato: 1**  
**IA nos cálculos: NÃO**

---

## BUG 1 — 🔴 CRÍTICO: Pipeline Velocity com double-counting

**Arquivo:** `server.js`, linha 1009  
**Função:** `ploomesGetDealsOwnerAggregates` (caminho API)

### Código atual:
```js
// Pipeline Velocity = (#won * ticketMedia * winRate%) / cicloMedio
pipelineVelocity = +((pd.won * ticketMedia * (winRate / 100)) / cicloMedio).toFixed(0);
```

### O problema:
`winRate = pd.won / (pd.won + pd.lost) * 100`

Substituindo na fórmula:
```
PV = pd.won * ticket * (pd.won / (pd.won + pd.lost)) / ciclo
   = pd.won² * ticket / ((pd.won + pd.lost) * ciclo)
```

`pd.won` aparece **duas vezes** — o deal ganho já está implícito no winRate, e ainda é multiplicado explicitamente.

### Fórmula correta (padrão Salesforce/HubSpot):
```
PV = oportunidades_totais * win_rate * ticket_médio / ciclo_médio
   = (won + lost) * (won / (won + lost)) * ticket / ciclo
   = won * ticket / ciclo
```

### Correção:
```js
// Opção A (direto):
pipelineVelocity = +((pd.won * ticketMedia) / cicloMedio).toFixed(0);

// Opção B (usando total de oportunidades, padrão da indústria):
const totalOpps = pd.won + pd.lost;
pipelineVelocity = +((totalOpps * (winRate / 100) * ticketMedia) / cicloMedio).toFixed(0);
```

**Impacto:** PV reportado é `pd.won / (pd.won + pd.lost)` vezes menor que o correto. Para um pipeline com 10 ganhos e 10 perdas (WR=50%), o valor atual é **metade** do correto.

---

## BUG 2 — 🔴 CRÍTICO: Duas fórmulas incompatíveis para Hygiene Score

**Arquivos:** `scripts/sync_warehouse.js` (linhas ~380-395) e `server.js` (linhas ~1720-1735)

### Implementação A — Warehouse (sync_warehouse.js):
```js
// Penalidade por contagem absoluta de problemas
let score = 100;
score -= Math.min(60, abandoned90 * 3);        // -3pts por deal abandonado (cap 60)
score -= Math.min(25, openNoAmount * 1);        // -1pt por deal sem valor (cap 25)
score -= Math.min(25, lostNoReasonPct * 100);   // -Xpts por % sem motivo (cap 25)
```

### Implementação B — API fallback (computeCrmHealth, server.js):
```js
// Score proporcional por percentuais
const pts_motivo  = (lostTotal - lostNoReason) / lostTotal * 40;  // 40pts max
const pts_valor   = withValue / totalOpen * 30;                    // 30pts max
const pts_atualiz = recentlyUpdatedOpen / totalOpen * 30;          // 30pts max
hygieneScore = Math.round(pts_motivo + pts_valor + pts_atualiz);
```

### O problema:
Mesmo vendedor, dados idênticos, **scores completamente diferentes** dependendo se o sistema serve via warehouse ou via API direta. Os pesos, as métricas consideradas (abandono vs. atualização recente) e a metodologia (absoluto vs. proporcional) são distintos.

**Exemplo numérico:**
- Vendedor com 5 deals abandonados, 20 deals sem valor, 0% sem motivo de perda
- **Warehouse:** 100 - min(60,15) - min(25,20) - 0 = 100 - 15 - 20 = **65**
- **API:** depende de totalOpen, withValue, recentlyUpdated — estruturalmente incomparável

**Impacto:** O badge 🟢/🟡/🔴 e o ranking de higiene são inconsistentes entre sessões (uma pode servir warehouse, outra API).

### Correção:
Unificar em uma única função `computeHygieneScore(metrics)` chamada pelos dois caminhos, garantindo mesma fórmula independente da fonte de dados.

---

## BUG 3 — 🟡 MÉDIO: win_rate com tipo e precisão inconsistentes

| Função | Linha | Tipo retornado | Exemplo |
|--------|-------|---------------|---------|
| `ploomesGetDealsOwnerAggregates` | 991, 1002 | `Number` (1 decimal) | `75.0` |
| `computeSalesIndicatorsWarehouse` | 1119, 1357 | `String` com "%" (2 decimais) | `"75.00%"` |

Código downstream que faz `winRate / 100` (linha 1009) assume Number. Se receber string `"75.00%"`, resulta em `NaN`.

Na prática este caminho específico usa `ploomesGetDealsOwnerAggregates` (retorna Number), então não causa erro agora — mas é uma bomba-relógio se as funções forem refatoradas.

### Correção:
Padronizar win_rate como `Number` em toda a cadeia. Formatar para exibição apenas no template/view.

---

## VALIDAÇÕES — O QUE ESTÁ CORRETO

### ✅ win_rate (warehouse mv_conversion)
```sql
CASE WHEN (won_count + lost_count) > 0 
  THEN (won_count * 1.0 / (won_count + lost_count)) 
  ELSE NULL 
END as win_rate
```
Fração correta (0.0–1.0), NULL quando sem dados. Confirmado no banco: `MAX=0.75, MIN=0.0`.

### ✅ Stale count hierárquico
Invariante `stale_30 >= stale_60 >= stale_90` verificada: 0 violações no run_id=11.

### ✅ Ticket médio e mediana
- `calcMedian` e `computeMedian`: implementações corretas com sort explícito
- Filtram `Amount <= 0` antes de calcular (linha 1133, 1370)
- Deals ganhos com Amount=0 geram alerta de qualidade de dados ✓

### ✅ Ciclo médio de venda
Calcula `(FinishDate - CreateDate)` em dias, considera apenas `days >= 0` (evita datas inversas), apenas deals ganhos.

### ✅ Stale count com timezone
`julianday()` do SQLite processa timestamps com offset `-03:00` corretamente. Sem bug de fuso.

### ✅ Penalidades de higiene (warehouse) — matemática interna OK
A lógica individual está correta; o problema é a divergência com o path API, não a fórmula em si.

---

## SOBRE O USO DE IA NOS CÁLCULOS

**Conclusão: Claude/Haiku NÃO é usado para calcular indicadores.**

`askClaude` e `askClaudeMessages` aparecem apenas em:
- Linha 3611, 3700: geração de resposta de chat para o usuário
- Linha 3721-3772: Sales Coach — interpretação de linguagem natural

Todas as funções `computeSalesIndicators`, `computeCrmHealth`, `computeRanking`, `computeDashboard` e `materialize` são **100% determinísticas** (SQL + JS aritmético). ✅

---

## DADOS DO WAREHOUSE (run_id=11, 2026-05-21)

| Métrica | Valor |
|---------|-------|
| Total de deals | 3.386 |
| Abertos | 688 |
| Ganhos | 601 |
| Perdidos | 2.097 |
| Owners com score 15 (mínimo) | 2 (IDs: 60001436, 10025551) |
| Owners com score ≥ 95 | 4 |

Score mínimo calculado vs esperado: **consistente** (expected_score == score em todas as linhas verificadas).

---

## PRIORIDADE DE CORREÇÃO

1. **Pipeline Velocity** (BUG 1) — corrigir antes do próximo relatório de funil
2. **Hygiene Score dual** (BUG 2) — risco de inconsistência entre sessões; unificar fórmula
3. **win_rate tipo** (BUG 3) — baixo risco atual, corrigir na próxima refatoração

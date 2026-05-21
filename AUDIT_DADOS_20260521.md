# Audit de Dados — CRM Ploomes Analyst
**Data:** 2026-05-21  
**Auditor:** Subagente Jarvis

---

## 1. Resultados das Queries

### 1.1 Deals Ganhos em Maio/2026 (status=2, a partir de 2026-05-01)
| owner_id   | ganhos | receita (R$)   |
|------------|--------|----------------|
| 60024924   | 3      | 5.053,64       |
| 60001436   | 3      | 124.715,00     |
| 10025551   | 2      | 6.091,51       |
| 60024641   | 1      | 0,00           |
| 60002566   | 1      | 1.340,00       |

**Total:** 10 deals ganhos | R$ 137.200,15 em receita  
⚠️ `60024641` fechou 1 deal com valor = R$0,00 — dado incompleto.

---

### 1.2 Taxa de Conversão Global (90 dias, mv_conversion)
> A query original solicitava `pipeline_id IS NULL`, mas essa combinação não existe na tabela (nenhuma linha retornada).  
> Resultado real usando todos os pipelines com `period_days=90`:

| won_count | lost_count | win_rate_pct |
|-----------|------------|--------------|
| 195       | 2.017      | **8,8%**     |

⚠️ **Bug confirmado:** `mv_conversion` não armazena linha de consolidação global (`pipeline_id IS NULL`). A query documentada retorna vazio.

---

### 1.3 Deals Parados >30 dias (status aberto, excluindo EXCLUDED_FROM_ANALYSIS)
| owner_id   | parados |
|------------|---------|
| 60001436   | 67      |
| 60000736   | 40      |
| 60002566   | 6       |
| 10025551   | 6       |

**Total parado:** 119 deals sem atualização há mais de 30 dias.  
⚠️ `60001436` lidera tanto em ganhos (3 deals) quanto em deals parados (67) — sinal de carteira grande não qualificada.

---

### 1.4 Interações nos últimos 7 dias (excluindo bot/dono)
| creator_id  | interações |
|-------------|------------|
| 10025551    | 115        |
| 60001436    | 81         |
| 60024641    | 40         |
| 60002566    | 38         |
| 60024924    | 35         |
| 60013800    | 32         |
| 10001177    | 29         |
| 60023650    | 10         |
| 10022193    | 5          |
| 10025857    | 3          |

---

### 1.5 Alertas Não Resolvidos (anomaly_alerts, history.db)
| severity  | count |
|-----------|-------|
| critical  | **400** |
| warning   | 41    |
| **Total** | **441** |

🚨 **400 alertas críticos sem resolução** — volume anormalmente alto. Indica que o sistema de alertas pode estar gerando ruído excessivo ou os alertas não estão sendo tratados.

---

### 1.6 Volume de Interações por Criador (histórico completo)
| creator_id  | total interações |
|-------------|-----------------|
| 60002566    | 3.239           |
| 10025551    | 2.343           |
| 60001436    | 2.177           |
| 10001177    | 1.158           |
| 60024924    | 962             |

Sem registros de criador com volume suspeito (ex: bot) claramente destacado. O volume de `60002566` (3.239) merece atenção — ~50% a mais que os demais. Pode refletir uso intenso legítimo ou automação de lançamento.

---

## 2. Análise do Score de Gamificação (computeRanking)

### Fórmula identificada no server.js (linhas ~2231–2340):

```
pontuacao = 0

Para cada deal GANHO no mês:
  + 8 pts (base)
  + min(20, floor(amount / 5000))  ← até +20 pts por receita

Para cada INTERAÇÃO no mês:
  + 0.5 pts
  Se TypeId = 2 ou 5 (visita/reunião):
    + 2 pts extras (total 2.5 por interação qualificada)

Para cada TAREFA concluída no prazo (FinishDate <= DateTime):
  + 3 pts

Para cada TAREFA em aberto vencida (DateTime <= now, criada no mês):
  - 2 pts

Para cada DEAL ABERTO sem atualização >30 dias:
  - 1 pt (cap: -20 pts por usuário)

Para cada SEMANA com coaching registrado no mês:
  + 2 pts
```

### Exemplo numérico — owner 60001436 (maio/2026):

| Componente                  | Cálculo                                     | Pontos |
|-----------------------------|---------------------------------------------|--------|
| 3 deals ganhos              | 3 × 8                                       | +24    |
| Receita R$124.715           | 3 deals: min(20, 124715/5000) → cada deal ~24.9, cap 20 → 3×20 | +60  |
| 81 interações (últimos 7d)  | estimativa ~350/mês × 0.5 (assumindo mix)   | +175   |
| 67 deals parados (cap -20)  | -1 × 20 (cap atingido)                      | -20    |
| **Score estimado**          |                                             | **~239+** |

**Obs.:** O componente de receita pode dominar o score quando há 1 deal de alto valor. R$124.715 em 3 deals dá +60 pts de receita versus +24 de volume — receita vale 2,5× mais que volume, conforme design intencional ("receita tem peso maior que volume puro").

---

## 3. Bugs e Problemas Encontrados

### 🔴 BUG CRÍTICO — mv_conversion sem linha global
- **O quê:** A view `mv_conversion` não possui linha com `pipeline_id IS NULL` para consolidação global.
- **Impacto:** A query de conversão global retorna **vazio**. Qualquer relatório que dependa dessa query retorna dados zerados ao usuário.
- **Onde:** Query no prompt de auditoria: `WHERE period_days=90 AND pipeline_id IS NULL`
- **Correção sugerida:** Adicionar linha consolidada na view/materialização, ou ajustar a query para `GROUP BY` sem filtro de pipeline.

### 🔴 BUG/RISCO — 400 alertas críticos não resolvidos
- **O quê:** `anomaly_alerts` acumula 400 alertas críticos sem `resolved_at`.
- **Impacto:** Se usados para disparar notificações, esses alertas podem estar silenciados ou causando spam. Se não usados, há risco de regressão não detectada.
- **Ação:** Revisar se o sistema de resolução automática está funcionando; avaliar se são falsos positivos.

### 🟡 AVISO — Deal ganho com amount = R$0,00
- **O quê:** owner `60024641` fechou 1 deal com valor zero em maio.
- **Impacto:** Não conta pontos de receita no score de gamificação; distorce métricas de ticket médio.
- **Ação:** Validar se o campo Amount é obrigatório no funil de fechamento.

### 🟡 AVISO — EXCLUDED_FROM_ANALYSIS inconsistente nas queries manuais
- **O quê:** As queries de auditoria excluem apenas `owner_id != 10001176`, mas o código exclui também `60023650` e `10025857`.
- **Impacto:** Os dados de parados e interações incluem esses dois usuários, que na aplicação são excluídos do ranking. Resultados divergem do que o sistema mostra.
- **Ação:** Usar `owner_id NOT IN (10001176, 60023650, 10025857)` em todas as queries de auditoria.

### 🟡 AVISO — Potencial inflação de score por interações em lote
- **O quê:** `60002566` tem 3.239 interações históricas — 50% acima do segundo colocado. No ranking mensal, interações a 0.5 pts/cada contribuem diretamente.
- **Impacto:** Se há lançamento em lote (ex: importação retroativa), o score pode não refletir atividade real.
- **Ação:** Verificar se há interações com `date` em massa no mesmo dia para esse usuário.

---

## 4. Resumo Executivo

| Item                          | Status     |
|-------------------------------|------------|
| Conversão global (90d)        | 8,8% ⚠️ abaixo do ideal; query oficial retorna vazio (bug) |
| Receita em maio               | R$ 137.200 em 10 deals ganhos |
| Deals parados >30d            | 119 (risco de carteira estagnada) |
| Maior gargalo: parados        | 60001436 com 67 deals parados |
| Alertas críticos não resolvidos | 400 🚨 |
| Score: componente dominante   | Receita (up to +20 pts/deal vs +8 base) |
| Bug principal                 | mv_conversion sem linha global → query retorna vazio |

---

*Gerado automaticamente por subagente Jarvis em 2026-05-21.*

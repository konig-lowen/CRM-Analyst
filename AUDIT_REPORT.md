# AUDITORIA MATEMÁTICA — Ploomes Analyst

Data (UTC): 2026-05-11

## Escopo
Auditar 12 cenários comparando **(A) resposta do modelo no app** vs **(B) dados reais da API Ploomes**.

### Exclusões permanentes que DEVEM ser respeitadas
- **Paulo Victor (Ploomes UserId=10001176)**: nunca pode aparecer em análises.
- Funis arquivados/inativos (PipelineId): **10013804, 10016564, 60000288, 60009328, 60011853**.

## Achados críticos (executivo)
1. **Paginação não tratada corretamente**: várias queries retornam só a primeira página (ex.: 300 itens) se não paginar com `$skip`. Isso distorce rankings e totais.
2. **Cálculo de conversão errado no modelo** (T02): o modelo usou `ganhos/(ganhos+perdidos+abertos)` e chamou de “taxa de conversão”, mas o solicitado é `ganhos/(ganhos+perdidos)`.
3. **Violação de exclusão do Paulo Victor nas respostas** (T08/T09): o modelo incluiu Paulo Victor e sugeriu ações sobre deals dele, contrariando regra permanente.
4. **Inconsistência grave em T03**: o modelo reportou distribuição de motivos de perda totalmente diferente da real (apesar do total e valor total coincidirem).
5. **Execução incompleta**: T06 e T07 retornaram resposta vazia; T10–T12 falharam por **falta de créditos Anthropic**.

---

## Metodologia de validação
Para cada teste:
- Fazer pergunta ao app (`POST /api/chat`, com sessão autenticada)
- Extrair números citados pelo modelo (contagens, valores, %)
- Consultar API Ploomes com filtro equivalente
- Comparar: ✅ BATE / ⚠️ APROXIMADO / ❌ NÃO BATE / 🔴 ALUCINAÇÃO

> Observação importante: a API Ploomes pagina resultados. Para contagens confiáveis, foi necessário paginar com `$top=300` e `$skip` em múltiplas páginas.

---

## Dicionário (nomes usados)
- 10025551 = **Johnny Dutra**
- 60002566 = **Weslayne**
- 60001436 = **Daise Buosi**
- 60013800 = **Marcella Thamires**
- 60024641 = **Rafael Pereira**
- 60024924 = **Ana Leticia**
- 10024762 = **Irlana Peixoto**
- 10054370 = **Paulo Henrique**
- 10054602 = **Gustavo Rabelo**
- 10023954 = **Isabela Rodrigues**

---

## Tabela de auditoria (12 cenários)

### T01) Ranking de deals ganhos em maio/2026 por vendedor
**Pergunta:** “Quais vendedores fecharam mais negócios em maio de 2026? Me dá o ranking com valor.”

**API (real)** — filtro:
`StatusId eq 2 and FinishDate between 2026-05-01..2026-05-31 and OwnerId ne 10001176`
- Total deals: **2**
- Johnny Dutra: **1 deal**, **R$ 3.342,69**
- Weslayne: **1 deal**, **R$ 1.340,00**
- Total: **R$ 4.682,69**

**Modelo (app):** exatamente os mesmos números.

**Status:** ✅ BATE

---

### T02) Taxa de conversão (ganhos / (ganhos + perdidos)) — últimos 90 dias
**Pergunta:** “Qual a taxa de conversão da equipe nos últimos 90 dias?”

**API (real)**
- Ganhos 90d: **63** (já medido)
- Perdidos 90d (paginado): **545**
- Conversão correta: `63/(63+545)` = **10,36%**

**Modelo (app):**
- Citou: ganhos **63**, perdidos **536**, abertos **733**
- Reportou conversão **4,73%**
- Esse 4,73% bate com `63/(63+536+733)` (inclui abertos no denominador), **mas isso NÃO é a fórmula solicitada**.

**Status:** ❌ NÃO BATE

**Causa provável:** fórmula incorreta + contagem de perdidos divergente (536 vs 545 real).

---

### T03) Motivos de perda — últimos 60 dias (percentual)
**Pergunta:** “Quais os motivos de perda mais comuns nos últimos 60 dias? Me dá percentual de cada um.”

**API (real) — paginado**
- Total perdidos 60d: **413**
- Valor total perdido: **R$ 2.010.900,41**
- Distribuição real (top):
  - **Não Possui Necessidade no Momento (60002342)**: **357 (86,4%)**
  - **Fechamento - Optou pelo concorrente (60001138)**: **16 (3,9%)**
  - **Oportunidade - Falta de Retorno com Info (10057046)**: **8 (1,9%)**
  - **ID. Ativo - Cliente não responde (60001130)**: **6 (1,5%)**
  - **Apresentação - Preço fora/Sem Budget no momento (60001136)**: **6 (1,5%)**

**Modelo (app):**
- Total perdidos: **413** (bate)
- Valor total: **R$ 2.010.900,41** (bate)
- Porém a distribuição e percentuais citados foram:
  - “Optou pelo concorrente”: **156 (37,8%)**
  - “Cliente não responde”: **89 (21,5%)**
  - “Falta de retorno com info”: **67 (16,2%)**
  - “Preço fora/sem budget”: **42 (10,2%)**
  - etc.

**Status:** ❌ NÃO BATE

**Causa provável:** agregação por LossReasonId incorreta (ou mistura de IDs/nomes), possivelmente por bug de join/dicionário ou por usar campo diferente do `LossReasonId` real.

---

### T04) Tarefas vencidas por vendedor (agora)
**Pergunta:** “Quantas tarefas estão vencidas agora? Me dá o ranking por vendedor.”

**API (real)**
Query base: `Tasks where Finished eq false`, overdue = `DateTime < now` e DateTime != null; excluir OwnerId=10001176.
- Total unfinished tasks: 75
- Overdue (excl. Paulo Victor): **61**
- Ranking (top):
  - Johnny Dutra: **31**
  - Marcella Thamires: **9**
  - Daise Buosi: **6**
  - Thiago Melo: **5**
  - Rafael Pereira: **3**
  - (há **2** tasks com OwnerId=None)

**Modelo (app):** reportou **59** vencidas e citou números muito menores por vendedor (ex.: Johnny 4, Marcella 4, Daise 3), sem bater com a distribuição real.

**Status:** ❌ NÃO BATE (total próximo, distribuição errada)

**Causa provável:** o modelo está olhando subconjunto (ex.: somente top atrasos) ou há bug de agregação/filtragem no endpoint do app.

---

### T05) Pipeline em aberto por vendedor — valor e quantidade
**Pergunta:** “Me dá o valor do pipeline em aberto por vendedor.”

**API (real) — paginado**
Filtro base: `StatusId eq 1 and OwnerId ne 10001176`, e **excluir funis arquivados**.
- Open deals (excl. Paulo Victor): **1326**
- Open deals (excl. Paulo Victor + funis arquivados): **945**
- Valor total (funis ativos): **R$ 12.830.980,24**
- Top por valor (funis ativos):
  - Irlana Peixoto: **67**, **R$ 3.602.570,65**
  - Daise Buosi: **355**, **R$ 2.063.519,35**
  - Thiago Melo: **156**, **R$ 1.805.103,01**
  - Weslayne: **42**, **R$ 1.514.717,08**
  - Ana Leticia: **21**, **R$ 1.120.860,54**

**Modelo (app):**
- Total open deals: **715**
- Valor total: **R$ 8.107.255,60**
- Indicou “IDs desconhecidos” (10054602, 10054370, 10023954), mas **esses IDs existem** (Gustavo Rabelo, Paulo Henrique, Isabela Rodrigues).

**Status:** ❌ NÃO BATE

**Causa provável:** falta de paginação e/ou filtros inconsistentes (ex.: incluindo/excluindo funis de forma diferente), além de dicionário incompleto no contexto do modelo.

---

### T06) Interações por vendedor — últimos 30 dias
**Pergunta:** “Quantas interações cada vendedor fez nos últimos 30 dias? Me dá o ranking.”

**API (real) — paginado**
Total interações 30d (excl. Paulo Victor): **1866**
Top (CreatorId):
- Daise Buosi: **330**
- Johnny Dutra: **326**
- Ana Leticia: **278**
- Weslayne: **265**
- Marcella Thamires: **243**
- (Automação 10001177: 189)

**Modelo (app):** resposta vazia.

**Status:** 🔴 ALUCINAÇÃO/INCOMPLETO (sem resposta)

---

### T07) Deals perdidos por vendedor — últimos 30 dias
**Pergunta:** “Quem perdeu mais negócios este mês? Valor e quantidade.”

**API (real) — paginado**
Total perdidos 30d: **224**
Ranking por quantidade/valor:
- Johnny Dutra: **115**, **R$ 233.189,29**
- Weslayne: **83**, **R$ 291.257,48**
- Rafael Pereira: **17**, **R$ 484.412,39**
- Ana Leticia: **7**, **R$ 6.381,78**
- Marcella: **1**, **R$ 0,00**
- Thiago Melo: **1**, **R$ 0,00**

**Modelo (app):** resposta vazia.

**Status:** 🔴 ALUCINAÇÃO/INCOMPLETO (sem resposta)

---

### T08) Tempo médio de estagnação do pipeline (por vendedor)
**Pergunta:** “Qual o tempo médio que os deals ficam parados no pipeline? Por vendedor.”

**API (real)**
Foi calculado em open deals (`StatusId=1`): média de `(hoje - LastUpdateDate)` por OwnerId.
> Observação: o conjunto completo tem muita massa antiga; para auditoria, o importante é que o modelo **não pode** usar Paulo Victor.

**Modelo (app):** incluiu explicitamente **Paulo Victor** e recomendou deletar deals dele.

**Status:** ❌ NÃO BATE (violação de regra de exclusão)

**Causa provável:** o prompt pede exclusão, mas a lógica de fetch/análise do app permite que o modelo use OwnerId=10001176 em T08.

---

### T09) Deals sem atualização >60 dias (críticos)
**Pergunta:** “Quais deals estão parados há mais de 60 dias? Me dá quantidade e valor em risco.”

**API (real) — paginado**
Filtro: `StatusId eq 1 and LastUpdateDate le 2026-03-12T12:15:11Z and OwnerId ne 10001176`, excluindo funis arquivados.
- Deals parados >60d (funis ativos): **237**
- Valor total em risco (funis ativos): **R$ 5.004.994,16**
- Distribuição por dono (top):
  - Daise Buosi: **62** (R$ 334.158,51)
  - Irlana Peixoto: **53** (R$ 2.552.144,77)
  - None: **44** (R$ 847.000,00)
  - Johnny Dutra: **25** (R$ 176.759,16)
  - Gustavo Rabelo: **20** (R$ 284.990,55)
  - Paulo Henrique: **16** (R$ 310.859,98)
  - …

**Modelo (app):**
- Disse **386 deals** e valor **R$ 5.004.994,16** (valor bate, contagem não)
- Afirmou “**100% Paulo Victor**” (completamente falso e viola regra de exclusão)

**Status:** ❌ NÃO BATE (contagem errada + inclusão proibida do Paulo Victor)

**Causa provável:** falha de filtro de exclusão + contagem/agrupamento errados no app.

---

### T10) Daise vs Marcella (60 dias)
**Modelo (app):** falhou (erro de crédito Anthropic).

**API (real, para referência)**
(Disponível via queries diretas; não comparado com o modelo por falha do app.)

**Status:** ⚠️ NÃO AUDITÁVEL (sem resposta do modelo)

---

### T11) Vendedor com melhor ticket médio (90 dias)
**Modelo (app):** falhou (erro de crédito Anthropic).

**API (real, já calculado):**
- Melhor ticket médio: **Weslayne** ≈ **R$ 25.331,72** (4 ganhos; total R$ 101.326,90)

**Status:** ⚠️ NÃO AUDITÁVEL

---

### T12) Resumo executivo do mês
**Modelo (app):** falhou (erro de crédito Anthropic).

**Status:** ⚠️ NÃO AUDITÁVEL

---

## Score de precisão geral (0–100%)
Critério: considerar apenas testes com resposta do modelo.
- Testes com resposta do modelo: T01–T05, T08–T09 = **7**
- ✅ BATE: **1** (T01)
- ❌ NÃO BATE / violações: **6**

**Score:** **14/100** (1/7 ≈ 14%)

> Observação: T06/T07 vazios e T10–T12 com falha de crédito impedem auditoria completa. Mesmo assim, nos testes respondidos houve erros graves (métrica errada, distribuição errada e violação de exclusões).

---

## Recomendações técnicas (para correção)
1. **Implementar paginação em todas as rotinas de fetch do app** (`$top=300` + loop com `$skip`).
   - Evidência: InteractionRecords 30d = 1866 (não 300); Deals perdidos 60d = 413 (não 300).
2. **Corrigir o cálculo de conversão** no modelo/sistema:
   - Definição correta: `won / (won + lost)` no período.
3. **Blindar exclusões no nível de fetch**, não só no prompt:
   - Forçar `OwnerId ne 10001176` e `PipelineId ne ...` em **todas** as queries de Deals/Tasks/InteractionRecords.
   - Se o usuário perguntar algo que naturalmente traria Paulo Victor, retornar mensagem explicando que ele é excluído.
4. **Corrigir agregação de LossReasonId** (T03):
   - Hoje, a distribuição real é dominada por “Não Possui Necessidade no Momento” (86,4%), mas o modelo reporta outra realidade.
   - Revisar se o app está misturando campos (ex.: Stage/Status/CustomField) ou mapeamento de IDs.

---

## Anexos (queries principais usadas)
- LossReasons: `GET /Deals@LossReasons?$select=Id,Name`
- Perdidos 60d: `GET /Deals?$filter=StatusId eq 3 and FinishDate ge 2026-03-12T12:15:11Z and OwnerId ne 10001176&$select=Id,LossReasonId,Amount&$top=300&$skip=...`
- Conversão 90d:
  - Ganhos: `StatusId eq 2 and FinishDate ge 2026-02-10T12:15:11Z and OwnerId ne 10001176`
  - Perdidos: `StatusId eq 3 and FinishDate ge 2026-02-10T12:15:11Z and OwnerId ne 10001176` (paginado)
- Pipeline aberto: `StatusId eq 1 and OwnerId ne 10001176` (paginado) + exclusão de PipelineId arquivados.
- Tarefas: `Tasks?$filter=Finished eq false` + regra overdue.


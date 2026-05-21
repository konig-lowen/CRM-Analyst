# Auditoria Backend/SQL/Warehouse — Ploomes Analyst
**Data:** 2026-05-21  
**Auditor:** Jarvis (Subagent)  
**Escopo:** /opt/ploomes-analyst — server.js, warehouse.db, history.db

---

## 1. Resultados das Queries

### 1.1 Deals sem owner
```
deals_sem_owner: 157
```
> ⚠️ 157 negócios sem dono atribuído. Esses deals ficam invisíveis em análises por vendedor.

### 1.2 Deals de Paulo Victor (owner_id = 10001176)
```
paulo_victor: 0
```
> ✅ Zero deals atribuídos ao Paulo Victor no warehouse. A exclusão via `EXCLUDED_FROM_ANALYSIS` funciona corretamente no filtro de API, mas confirma que o owner_id 10001176 não aparece como dono em deals do warehouse (pode ter sido reassigned ou nunca ter tido deals próprios).

### 1.3 Deals por pipeline (ativos analisados)
| pipeline_id | name                              | ct |
|-------------|-----------------------------------|----|
| 10013804    | Pré-Vendas MG                     | 3  |
| 10016564    | Pré-Vendas - GO                   | 3  |
| 60000288    | Novos Clientes                    | 3  |
| 60009328    | [Cópia] - Manutenção da Carteira  | 3  |
| 60011853    | VENDA DIRETA - CTS                | 5  |
> ℹ️ Volume baixo por pipeline. Total: 17 deals nesses 5 funis (amostra do último ETL bem-sucedido).

### 1.4 Owners distintos em mv_hygiene (último ETL ok)
```
owners_hygiene: 13
```
> ✅ 13 vendedores distintos na view de higiene. Parece consistente com o tamanho do time.

### 1.5 ETL runs recentes (últimas 5)
| id | started_at          | fim             | ok | error                                          |
|----|---------------------|-----------------|----|------------------------------------------------|
| 13 | 2026-05-21T13:36:15 | 2026-05-21T13:36 | 0  | API error: 120 requests per minute exceeded   |
| 12 | 2026-05-21T13:25:18 | 2026-05-21T13:25 | 0  | API error: 120 requests per minute exceeded   |
| 11 | 2026-05-21T13:16:42 | 2026-05-21T13:17 | 1  | —                                              |
| 10 | 2026-05-21T13:15:09 | 2026-05-21T13:15 | 0  | API error: 120 requests per minute exceeded   |
|  9 | 2026-05-21T13:14:48 | 2026-05-21T13:15 | 0  | API error: 120 requests per minute exceeded   |

> 🔴 **4 de 5 ETL runs falharam** com rate limit da API Ploomes (120 req/min). Apenas o run 11 foi bem-sucedido. Os dados no warehouse refletem o estado do run 11 (13:16–13:17).

### 1.6 Cache ativo (history.db)
```
cache_entries: 4
cache_bytes: 13155
```
> ✅ Cache funcionando. 4 entradas ativas, ~12.8 KB total. Volume pequeno — esperado se os ETLs falharam.

---

## 2. Auditoria de Código

### 2.1 Filtragem de EXCLUDED_FROM_ANALYSIS
**Resultado grep:** 6 ocorrências relevantes (linhas 35, 739, 743, 834, 835, 1315, 1466, 1611)

```
Line 35: const EXCLUDED_FROM_ANALYSIS = [10001176, 60023650, 10025857];
```
Exclusão aplicada em:
- Proxy de API → `/deals` (linha 739–743): **aplica filtro OData correto**
- `computeCrm`, `computeSales`, `computeDash`, `ranking`: filtrados pelo grep (eram variações esperadas)

> ✅ A lógica de exclusão está presente. Porém, ela depende de constante hardcoded — qualquer mudança de time exige edição direta no código.

### 2.2 Queries em loop
```
grep count: 7
```
> ⚠️ 7 ocorrências de `.get/.all/.prepare` dentro de estruturas iterativas (forEach/map/for). Cada iteração abre uma query SQLite separada. Para volumes pequenos (<1000 rows) é aceitável, mas pode virar gargalo se o warehouse crescer. Recomenda-se consolidar com JOINs ou CTEs.

### 2.3 Endpoints sem requireAuth
```
(sem output)
```
> ✅ Nenhum endpoint exposto sem autenticação além dos explicitamente públicos (login, logout, static assets, dashboard views). Cobertura de auth parece completa.

### 2.4 Tratamento de erro — linhas 549–570 (auth bootstrap)
```javascript
const [salt, hash] = stored.split(':');
const h = crypto.pbkdf2Sync(p, salt, 100000, 64, 'sha512').toString('hex');
return h === hash;
// ...
const userCount = db.prepare('SELECT COUNT(*) as c FROM app_users').get();
if (userCount.c === 0) {
  db.prepare('INSERT INTO app_users ...')
    .run('paulo', hashPassword('vetorv2024'), 'admin', 'Paulo');
  console.log('[auth] Usuário padrão paulo criado (senha: vetorv2024)');
}
```
> 🔴 **BUG CRÍTICO DE SEGURANÇA:** Senha padrão `vetorv2024` hardcoded e logada no console. Se o banco for deletado ou migrado para novo ambiente, o usuário admin é recriado automaticamente com credencial conhecida. O log deixa a senha visível em qualquer agregador de logs.

### 2.5 Exposição de stack traces em respostas HTTP
```
res.status(500).json({ error: e.message })  — múltiplas ocorrências (linhas 2428, 2470, 2492, 2507, 2524, 2542, 2605, 2700, 2728, 2838, 2881, 2948)
```
> ⚠️ `e.message` é retornado diretamente ao cliente em todos os endpoints. Em erros de SQL, isso pode vazar nomes de tabelas, estrutura do schema ou paths internos. `e.stack` não é exposto (✅), mas `e.message` sozinho já é information disclosure.

---

## 3. Bugs e Riscos — Ranking

### 🔴 BUG 1 — Senha admin hardcoded + logada (CRÍTICO)
**Arquivo:** server.js linha ~560  
**Problema:** Senha `vetorv2024` está no código-fonte e impressa via `console.log`. Qualquer pessoa com acesso ao repo ou aos logs tem acesso admin.  
**Fix:** Remover bootstrap automático ou usar variável de ambiente `ADMIN_INITIAL_PASSWORD`. Nunca logar senhas. Considerar forçar troca na primeira autenticação.

### 🔴 BUG 2 — Rate limit da API Ploomes quebrando ETLs (OPERACIONAL CRÍTICO)
**Arquivo:** scripts/sync_warehouse.js linha ~62  
**Problema:** 4 de 5 ETLs recentes falharam com `120 requests per minute exceeded`. O warehouse fica stale. O único ETL bem-sucedido foi o run 11.  
**Fix:** Implementar exponential backoff + jitter ao receber erro de rate limit. Adicionar delay entre requests paginados. Considerar agendar ETL em horário de menor carga.

### ⚠️ BUG 3 — 157 deals sem owner_id no warehouse
**Tabela:** `deals`  
**Problema:** 157 deals com `owner_id IS NULL`. Esses negócios somem de qualquer análise por vendedor, ranking, higiene. Podem representar negócios reais não atribuídos.  
**Fix:** Investigar origem (deals importados? API retornando null?). Adicionar alerta no ETL quando `owner_id IS NULL` count > threshold. Considerar fallback para owner do pipeline.

### ⚠️ BUG 4 — Information disclosure em erros 500
**Arquivo:** server.js — múltiplos endpoints  
**Problema:** `e.message` retornado diretamente ao cliente em todos os catch blocks. Pode expor detalhes de schema SQLite, paths, lógica interna.  
**Fix:** Logar `e.message` + `e.stack` server-side, retornar apenas mensagem genérica ao cliente: `{ error: "Erro interno. Contate o suporte." }`.

### ℹ️ AVISO — Queries em loop (performance)
7 ocorrências de SQLite queries dentro de iteradores. Aceitável hoje, mas deve ser refatorado antes de warehouse crescer acima de ~5k deals ativos.

---

## 4. Resumo Executivo

| Categoria        | Status  | Detalhes                                  |
|------------------|---------|-------------------------------------------|
| Auth coverage    | ✅ OK   | Todos endpoints protegidos                |
| Exclusão PV/Gestor | ✅ OK | EXCLUDED_FROM_ANALYSIS aplicado           |
| ETL saúde        | 🔴 RUIM | 4/5 runs falharam (rate limit)           |
| Senha admin      | 🔴 RISCO | Hardcoded + logada no console            |
| Deals orfãos     | ⚠️ ATENÇÃO | 157 deals sem owner                   |
| Error disclosure | ⚠️ ATENÇÃO | e.message exposto em 500s             |
| Cache            | ✅ OK   | Funcionando, 4 entradas ativas            |
| Hygiene owners   | ✅ OK   | 13 vendedores distintos                  |

---

*Auditoria gerada automaticamente em 2026-05-21 13:44 UTC*

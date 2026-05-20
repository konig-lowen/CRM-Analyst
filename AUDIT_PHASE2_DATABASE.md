# AUDIT — Fase 2: Banco de Dados
**Data:** 2026-05-20
**Arquivos analisados:** `history.db`, `warehouse.db`, `sessions.db`, `server.js`, `scripts/sync_warehouse.js`

---

## Resumo Executivo

O sistema usa dois bancos SQLite: `history.db` (app: usuários, mensagens, metas, cache) e `warehouse.db` (ETL de dados do Ploomes CRM). A modelagem geral é adequada para o volume atual (~3.3k deals, ~11k interações, ~822 tarefas), mas há riscos relevantes de crescimento, integridade referencial e rastreabilidade que precisam ser endereçados antes de escalar.

---

## Problemas Identificados

---

**[🟠] FK sem enforcement — integridade referencial inexistente em history.db**
- **Descrição:** Todas as tabelas do `history.db` usam INTEGER como FK (`user_id`, `team_id`, etc.) mas nenhuma FOREIGN KEY constraint foi declarada no schema. O SQLite tem FK desativado por padrão; sem `PRAGMA foreign_keys = ON` no init e sem declaração de constraints, é possível ter orphan records (ex: `goals` com `user_id` inexistente, `team_members` com `user_id` deletado).
- **Impacto real:** Dados órfãos não causam erro, mas corroem análises. Um usuário deletado deixa metas, sessões de chat e coaching_summaries soltos para sempre.
- **Risco futuro:** Cresce com o tempo — difícil de detectar e limpar depois de meses de operação.
- **Solução técnica:** Adicionar `PRAGMA foreign_keys = ON` imediatamente após abrir a conexão do `history.db` (já foi feito no `warehouse.db`). Adicionar constraints explícitas nas tabelas via migração: `FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE`.

---

**[🟠] fetch_cache sem limpeza automática confiável + crescimento ilimitado**
- **Descrição:** A tabela `fetch_cache` tem TTL de 7 dias por registro e um limite de 200 entradas por `(user_id, chat_session_id)`. A limpeza de expirados só ocorre quando `setCachedFetch` é chamado (lazy cleanup). Se o usuário nunca escrever mais cache, os registros expirados permanecem indefinidamente. O schema permite crescimento irrestrito em número de `chat_session_id` distintos — cada sessão acumula até 200 entradas, sem limite global.
- **Impacto real:** Banco pode crescer vários MB/mês em produção com uso intenso, sem que o usuário perceba.
- **Risco futuro:** SQLite degrada com arquivos grandes e muitas escritas concorrentes; em VPS com disco limitado isso é crítico.
- **Solução técnica:** (1) Adicionar um job de limpeza periódica (`setInterval`) que rode `DELETE FROM fetch_cache WHERE expires_at <= CURRENT_TIMESTAMP` a cada 1h. (2) Adicionar um índice composto `(expires_at, user_id)` para a query de cleanup ser eficiente. (3) Limitar crescimento global com um cron semanal de VACUUM.

---

**[🟠] messages.chat_session_id — coluna adicionada via ALTER sem migração de dados**
- **Descrição:** A tabela `messages` tem uma coluna `chat_session_id` (visível no schema real) que não está no schema inicial definido no `db.exec(...)` do `server.js`. Isso indica uma migração manual/ad-hoc que não está refletida no código. A coluna é usada nas queries de `getSessionCacheContext` mas nunca é populada no fluxo principal de inserção de mensagens (não há `INSERT INTO messages ... chat_session_id` no código auditado).
- **Impacto real:** Cache de contexto de sessão (`getSessionCacheContext`) retorna sempre vazio para todas as mensagens antigas, pois `chat_session_id` é NULL. A funcionalidade de "dados já disponíveis nesta sessão" pode não funcionar corretamente.
- **Risco futuro:** Toda nova instância/deploy parte de um schema diferente do banco em produção — risk de divergência silenciosa.
- **Solução técnica:** Documentar todas as migrações em um arquivo `migrations/` versionado (ex: `001_add_chat_session_id.sql`). Garantir que o `INSERT INTO messages` popule `chat_session_id` quando disponível.

---

**[🟡] Ausência de índices para queries de dashboard e ranking**
- **Descrição:** As queries mais pesadas do sistema (ranking, computeSalesIndicators, computeCrmHealth) fazem full-scan em `fetch_cache` por `(user_id, chat_session_id, expires_at)` e em `coaching_summaries` por `(user_id, created_at)`. O índice `idx_coaching_user ON coaching_summaries(user_id)` existe, mas a query filtra também por `created_at` — o índice composto `(user_id, created_at)` seria 10-100x mais eficiente.
- **Impacto real:** Baixo agora (~100s de registros), mas perceptível quando `coaching_summaries` e `fetch_cache` crescerem.
- **Risco futuro:** Com 12+ meses de uso e múltiplos vendedores, as queries de ranking por período vão degradar.
- **Solução técnica:**
  ```sql
  CREATE INDEX IF NOT EXISTS idx_coaching_user_date ON coaching_summaries(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_user_session ON messages(user_id, chat_session_id);
  ```

---

**[🟡] warehouse.db — sem índice composto (status_id, finish_date) em deals**
- **Descrição:** As queries mais frequentes no warehouse filtram por `status_id` e `finish_date` simultaneamente (ex: `WHERE status_id = 2 AND finish_date >= ?`). Os índices existentes são individuais: `idx_deals_status_id` e `idx_deals_finish_date`. O SQLite usará apenas um deles, fazendo full-scan no outro.
- **Impacto real:** Para 3.3k deals atual, imperceptível. Com 20k+ deals, queries de conversão por período ficarão lentas (100-500ms).
- **Risco futuro:** Alto — o volume de deals cresce continuamente; esse índice só fica mais importante.
- **Solução técnica:**
  ```sql
  CREATE INDEX IF NOT EXISTS idx_deals_status_finish ON deals(status_id, finish_date);
  CREATE INDEX IF NOT EXISTS idx_deals_owner_status ON deals(owner_id, status_id);
  ```

---

**[🟡] Sem retenção / particionamento — crescimento ilimitado de messages e fetch_cache**
- **Descrição:** A tabela `messages` (histórico de chat) e `fetch_cache` crescem indefinidamente. Não há política de retenção (ex: manter apenas últimos 90 dias de mensagens por usuário). Com uso intenso, `history.db` pode superar 1 GB.
- **Impacto real:** SQLite performa bem até ~500MB; acima disso, escritas e leituras degrada visualmente.
- **Risco futuro:** Em 12-18 meses de operação sem limpeza, o arquivo pode criar gargalo de disco/IO.
- **Solução técnica:** Adicionar um job semanal de retenção:
  ```sql
  DELETE FROM messages WHERE created_at < datetime('now', '-180 days');
  DELETE FROM fetch_cache WHERE expires_at < CURRENT_TIMESTAMP;
  VACUUM;
  ```
  E arquivar (exportar para JSON/CSV) antes de deletar, se auditabilidade for necessária.

---

**[🟡] Sem auditoria/rastreabilidade de alterações — tabelas críticas sem log**
- **Descrição:** Tabelas como `app_users`, `goals` e `team_members` não possuem nenhum registro de auditoria (quem criou, quem alterou, quem deletou e quando). A coluna `updated_at` em `goals` existe mas não é atualizada automaticamente via trigger — depende do código fazer o UPDATE manual, o que pode ser esquecido.
- **Impacto real:** Impossível saber se uma meta foi alterada retroativamente, quem criou um usuário, ou quando um vendedor foi removido de uma equipe.
- **Risco futuro:** Qualquer divergência de dados ou suspeita de manipulação é impossível de investigar.
- **Solução técnica:** (1) Criar triggers de `updated_at` automático para `goals`. (2) Criar tabela `audit_log (id, table_name, row_id, action, old_json, new_json, user_id, created_at)` e popular via triggers ou middleware Express. Prioridade alta para `goals` e `app_users`.

---

**[🟡] Sem índice em teams.supervisor_user_id — query de canAccessUserId é O(n)**
- **Descrição:** A função `canAccessUserId` faz um JOIN `team_members → teams WHERE supervisor_user_id = ?` mas não existe índice em `teams(supervisor_user_id)`. Esta query é executada em toda requisição autenticada de supervisor.
- **Impacto real:** Baixo (poucas equipes hoje). Com dezenas de equipes, torna-se lento.
- **Solução técnica:**
  ```sql
  CREATE INDEX IF NOT EXISTS idx_teams_supervisor ON teams(supervisor_user_id);
  ```

---

**[🟢] Modelagem geral — adequada para o estágio atual**
- **Descrição:** A separação entre `history.db` (app state) e `warehouse.db` (ETL analytics) é uma boa decisão arquitetural. O warehouse tem índices cobertos para as queries principais de análise. As materialized views (`mv_hygiene`, `mv_conversion`, `mv_pipeline_snapshot`) são um padrão correto para evitar recalcular tudo a cada request.
- **Impacto real:** Sem problemas imediatos.
- **Risco futuro:** À medida que novas análises forem adicionadas, garantir que novas MVs sigam o mesmo padrão de `run_id` para invalidação limpa.
- **Solução técnica:** Documentar o contrato das MVs e adicionar índice em `mv_hygiene(run_id, owner_id)` se queries por owner se tornarem frequentes.

---

## Queries N+1 Identificadas

| Local no código | Problema | Impacto |
|---|---|---|
| `computeRanking` | Faz `db.prepare(...).get(appId, ...)` em loop para cada `scopeAppUserIds` dentro do loop de usuários | N queries ao DB por request de ranking |
| `canAccessUserId (supervisor)` | Executa query de times a cada verificação de acesso | N queries por request autenticado de supervisor |
| `computeDashboard` → `ploomesGetAll` × 5 calls | Não é N+1 mas são 5 chamadas paralelas a API externa; veja Fase 3 | Latência acumulada |

**Solução:** Para o ranking, pré-carregar todos os `coaching_summaries` por período em uma única query com `WHERE user_id IN (...)` antes do loop, em vez de uma query por user_id.

---

## Sumário de Prioridades

| Prioridade | Item |
|---|---|
| 🟠 Alta | FK enforcement em history.db |
| 🟠 Alta | fetch_cache sem limpeza automática confiável |
| 🟠 Alta | chat_session_id não populado / migração sem documentação |
| 🟡 Média | Índices compostos ausentes (warehouse + history) |
| 🟡 Média | Sem retenção de dados antigos |
| 🟡 Média | Sem auditoria de alterações em tabelas críticas |
| 🟡 Média | N+1 no ranking e canAccessUserId |
| 🟢 Baixa | Modelagem geral sólida — sem ação urgente |

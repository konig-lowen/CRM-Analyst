# OPS_LOG — CRM Analyst (Ploomes)

Objetivo: registrar **alterações**, **erros encontrados** e **correções** (com data/UTC) para permitir reconstrução e auditoria do sistema.

Regras:
- Este arquivo é **append-only** (não sobrescrever; sempre adicionar no topo ou ao final com data).
- Sempre anotar: *o que mudou*, *por que*, *arquivos/rotas afetadas*, *risco*, *como validar*.

---

## 2026-05-13
- **Criado/ativado log de operações para reconstrução**
  - Arquivo (append-only): `/opt/ploomes-analyst/OPS_LOG.md`.
- **Backup diário para Google Drive confirmado** (cron 03:00 UTC).
  - Cron: `/etc/cron.d/ploomes-analyst-backup` → roda `/opt/ploomes-analyst/scripts/backup.sh` e grava log em `/var/log/ploomes-analyst-backup.log`.
  - Drive (rclone remote `gdrive_pcm:`): pasta `Sistema Consulta Parte List/CRM-Analyst-Backups/` contém zips `crm-analyst_20260509...` até `crm-analyst_20260513...`.
- **Backup.sh ajustado para também versionar logs no Drive** (a partir do próximo cron):
  - Script: `/opt/ploomes-analyst/scripts/backup.sh`
  - Log append-only de backups: `/opt/ploomes-analyst/backups/backup-log.md`
  - Upload do próprio `/opt/ploomes-analyst/OPS_LOG.md`
  - Validação: `bash -n /opt/ploomes-analyst/scripts/backup.sh`.

## 2026-05-12
- **SPA/UI principal (app.html) consolidada** + atualização do `server.js`.
  - UI contém navegação e views (ex.: Chat, Dashboard, Ranking, Relatórios, Admin) e consome endpoints `/api/*`.
  - Relatórios (SPA): chama `/api/reports/users` e `/api/reports/ploomes/:ploomesUserId`.
  - Evidência (mtime): `app.html` e `server.js` em 2026-05-12 (UTC).
- **Observabilidade**
  - `server.log` registrou erros em rotas de reports (ver seção “Erros/alertas”).

## 2026-05-11
- **Warehouse (ETL local) introduzido** para reduzir chamadas ao Ploomes e consolidar indicadores.
  - Script: `/opt/ploomes-analyst/scripts/sync_warehouse.js`.
  - DB: `/opt/ploomes-analyst/warehouse.db` + tabelas materializadas `mv_*` (mv_pipeline_snapshot, mv_conversion, mv_loss_reasons, mv_hygiene).
  - Observabilidade: endpoint admin `GET /api/warehouse/status`.
  - Integração no app: preferência por warehouse quando “fresh”; caso stale, dispara sync em background e faz fallback para API.
- **Relatório executivo HTML**
  - Endpoint: `POST /api/admin/send-exec-report`.
  - Saída: HTML em `/opt/ploomes-analyst/backups/` (SMTP opcional via env + nodemailer).
- **Auto-vínculo de usuário (ploomes_user_id)**
  - Login tenta resolver Ploomes user por e-mail e persistir em `app_users.ploomes_user_id`.
  - Admin create user também tenta auto-resolver; UI de admin passou a ter dropdown fallback com `/api/ploomes-users`.
- **Audit/Test artifacts gerados**
  - Auditoria matemática: `/opt/ploomes-analyst/AUDIT_REPORT.md` (2026-05-11).
  - Test report: `/opt/ploomes-analyst/TEST_REPORT.md` (gerado 2026-05-10, usado como baseline).
---

## Erros/alertas conhecidos (e pistas de correção)
- **Reports / Ploomes retornando 403/HTML**
  - Sintoma: logs do servidor mostram `API error: Your request has been forbidden` e/ou `API retornou string: <!DOCTYPE html...`.
  - Evidência: `/opt/ploomes-analyst/server.log`.
  - Hipóteses comuns: filtro/endpoint do Ploomes proibido, rate-limit/WAF, ou request fora do padrão esperado.

- **Achados de auditoria (não assumir “corrigido” sem re-teste)**
  - Fonte: `/opt/ploomes-analyst/AUDIT_REPORT.md` (2026-05-11).
  - Paginação incompleta em algumas consultas (distorsão de totais/rankings) → exigir paginação ou usar warehouse/materializações.
  - Fórmula de conversão: modelo pode usar denominador errado (inclui abertos) → precisa validação via métricas calculadas no backend.
  - Exclusões permanentes: Paulo Victor (Ploomes UserId=10001176) e funis inativos precisam ser aplicados em *tudo*.
  - Motivos de perda (LossReasonId): distribuição pode sair errada mesmo quando total bate → suspeitar de agregação/dicionário.
  - Tasks vencidas: total “perto”, mas distribuição por vendedor errada → suspeitar de filtro/subconjunto.

- **Achados de testes automatizados**
  - Fonte: `/opt/ploomes-analyst/TEST_REPORT.md` (2026-05-10).
  - Divergência recorrente: confusão entre `tasks_open` vs `tasks_overdue` em janelas 90/180 dias (filtro `DateTime le end`).
  - Rate-limit/429 observado em janelas amplas (180d) em alguns momentos.
  - Mitigações descritas no report: impor filtro de data obrigatório em /Deals, /Tasks, /InteractionRecords; cache curto em memória; reduzir payload (amostra + count/sum).
## Como validar (mínimo)
- Acesso: `https://crm.vetorv.com.br/login`.
- Backup: checar `/var/log/ploomes-analyst-backup.log` e listar no Drive via `rclone ls`.
- Warehouse: checar `/api/warehouse/status` (admin) e última run OK.

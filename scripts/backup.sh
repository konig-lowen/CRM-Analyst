#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/ploomes-analyst"
TS="$(date -u +"%Y%m%d_%H%M%SZ")"
OUT_DIR="${APP_DIR}/backups"
NAME="crm-analyst_${TS}.zip"
BACKUP_LOG_LOCAL="${OUT_DIR}/backup-log.md"
OPS_LOG="${APP_DIR}/OPS_LOG.md"

mkdir -p "$OUT_DIR"

# Append-only backup log (local)
{
  echo "- ${TS} UTC — backup iniciado (${NAME})"
} >> "$BACKUP_LOG_LOCAL"

# (Legacy) CHANGELOG.md was previously overwritten on each backup.
# Keep it as a small marker file, but don't rely on it for audit/reconstruction.
CHANGELOG="${APP_DIR}/CHANGELOG.md"
{
  echo "# CHANGELOG"
  echo
  echo "- ${TS} UTC — Backup automático"
} > "$CHANGELOG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Copy code (without node_modules/backups)
rsync -a --delete \
  --exclude "node_modules" \
  --exclude "backups" \
  --exclude ".git" \
  "$APP_DIR/" "$TMP/ploomes-analyst/" >/dev/null

# Ensure DB included
cp -f "$APP_DIR/history.db" "$TMP/ploomes-analyst/history.db"

cd "$TMP"
zip -qr "$OUT_DIR/$NAME" "ploomes-analyst"

# Upload to Google Drive via rclone
rclone copy "$OUT_DIR/$NAME" "gdrive_pcm:Sistema Consulta Parte List/CRM-Analyst-Backups/" \
  --drive-root-folder-id "1kJGmIHLbIJB8Cu1baoYN2gT5zzXqA_qN"

# Upload logs/manifests too (helps reconstruction)
if [ -f "$BACKUP_LOG_LOCAL" ]; then
  rclone copy "$BACKUP_LOG_LOCAL" "gdrive_pcm:Sistema Consulta Parte List/CRM-Analyst-Backups/" \
    --drive-root-folder-id "1kJGmIHLbIJB8Cu1baoYN2gT5zzXqA_qN" || true
fi

if [ -f "$OPS_LOG" ]; then
  rclone copy "$OPS_LOG" "gdrive_pcm:Sistema Consulta Parte List/CRM-Analyst-Backups/" \
    --drive-root-folder-id "1kJGmIHLbIJB8Cu1baoYN2gT5zzXqA_qN" || true
fi

{
  echo "- ${TS} UTC — backup finalizado (OK) (${NAME})"
} >> "$BACKUP_LOG_LOCAL"

echo "OK: $OUT_DIR/$NAME"

#!/bin/bash
# Auto-sync CRM Analyst → GitHub
# Roda via cron a cada 30 minutos

cd /opt/ploomes-analyst || exit 1

# Atualiza token do gh (renova automaticamente)
GH_TOKEN=$(gh auth token 2>/dev/null)
if [ -z "$GH_TOKEN" ]; then
  echo "[git_sync] ERRO: gh auth token falhou"
  exit 1
fi

# Atualiza remote com token fresco
git remote set-url origin "https://konig-lowen:${GH_TOKEN}@github.com/konig-lowen/CRM-Analyst.git"

# Verifica se há mudanças
if git diff --quiet && git diff --cached --quiet; then
  # Nenhuma mudança staged/unstaged
  UNTRACKED=$(git ls-files --others --exclude-standard | wc -l)
  if [ "$UNTRACKED" -eq 0 ]; then
    echo "[git_sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) Nada a commitar."
    exit 0
  fi
fi

# Adiciona tudo (respeitando .gitignore)
git add -A

# Commit só se tiver algo staged
if git diff --cached --quiet; then
  echo "[git_sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) Nada a commitar após add."
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
git commit -m "auto-sync: ${TIMESTAMP}"

# Push
if git push origin main 2>&1; then
  echo "[git_sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) Push OK"
else
  echo "[git_sync] $(date -u +%Y-%m-%dT%H:%M:%SZ) ERRO no push"
  exit 1
fi

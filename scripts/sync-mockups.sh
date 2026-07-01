#!/usr/bin/env bash
# Sync local mockup assets (PSDs/images) to the Hetzner server.
# The mockup files are gitignored, so they don't ride along with a normal deploy.
# Run this from the Mac whenever mockups have been added/removed locally.
#
# Overrides (optional):
#   DEPLOY_HOST=178.105.133.152 DEPLOY_USER=ben DEPLOY_PATH=/home/ben/upload-atelier-faille ./scripts/sync-mockups.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-178.105.133.152}"
USER="${DEPLOY_USER:-ben}"
REMOTE_PATH="${DEPLOY_PATH:-/home/ben/upload-atelier-faille}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL="$ROOT/data/mockups/"
REMOTE="$USER@$HOST:$REMOTE_PATH/data/mockups/"

if [ ! -d "$LOCAL" ]; then
  echo "no local mockup dir at $LOCAL — nothing to sync" >&2
  exit 0
fi

echo "→ syncing mockups"
echo "   from: $LOCAL"
echo "   to:   $REMOTE"
rsync -avz --progress --delete "$LOCAL" "$REMOTE"
echo "✓ mockups in sync"

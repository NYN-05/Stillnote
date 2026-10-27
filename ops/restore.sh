#!/usr/bin/env bash
# Replaces the Stillnote database with the contents of a dump made by ops/backup.sh.
#   ops/restore.sh path/to/stillnote-....dump [--yes]
# Environment: COMPOSE_FILE (default docker-compose.prod.yml), ENV_FILE (compose --env-file).
# The api and web containers are stopped during the restore and started again afterwards.
set -euo pipefail

file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "Usage: ops/restore.sh path/to/dump [--yes]" >&2
  exit 2
fi
compose=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}")
if [[ -n "${ENV_FILE:-}" ]]; then compose+=(--env-file "$ENV_FILE"); fi

if [[ "${2:-}" != "--yes" ]]; then
  read -r -p "This REPLACES all current data with $file. Type 'restore' to continue: " answer
  [[ "$answer" == "restore" ]] || { echo "Aborted."; exit 1; }
fi

echo "Stopping api and web..."
"${compose[@]}" stop api web

echo "Restoring..."
# --clean --if-exists drops existing objects first; --single-transaction makes it all-or-nothing.
"${compose[@]}" exec -T postgres pg_restore -U stillnote -d stillnote --clean --if-exists --no-owner --single-transaction <"$file"

echo "Starting api and web..."
"${compose[@]}" start api web
echo "Restore complete."

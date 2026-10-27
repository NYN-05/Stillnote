#!/usr/bin/env bash
# Writes a compressed PostgreSQL dump of the Stillnote database and prunes old ones.
#   ops/backup.sh [output-dir]
# Environment: COMPOSE_FILE (default docker-compose.prod.yml), ENV_FILE (compose --env-file), KEEP (dumps to keep, default 14).
# Run it from cron or a scheduler, and copy the dumps off the host: a backup on the same disk is not a backup.
set -euo pipefail

dir="${1:-backups}"
keep="${KEEP:-14}"
compose=(docker compose -f "${COMPOSE_FILE:-docker-compose.prod.yml}")
if [[ -n "${ENV_FILE:-}" ]]; then compose+=(--env-file "$ENV_FILE"); fi

mkdir -p "$dir"
file="$dir/stillnote-$(date -u +%Y%m%dT%H%M%SZ).dump"

# Custom format (-Fc) is compressed and lets pg_restore pick what to restore.
"${compose[@]}" exec -T postgres pg_dump -U stillnote -d stillnote -Fc >"$file.partial"

# Refuse to keep a dump that pg_restore cannot read.
if ! "${compose[@]}" exec -T postgres pg_restore --list <"$file.partial" >/dev/null; then
  rm -f "$file.partial"
  echo "Backup failed verification; nothing was written." >&2
  exit 1
fi
mv "$file.partial" "$file"

# Retention: keep the newest $keep dumps.
ls -1t "$dir"/stillnote-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; done

echo "$file ($(wc -c <"$file") bytes)"

#!/usr/bin/env bash
# Seeds (or removes) load-test data in the running Postgres container.
#   loadtest/seed.sh [users] [notes_per_user]     default 500 users x 20 notes = 10,000 notes
#   loadtest/seed.sh --cleanup
# Environment: COMPOSE_FILE (default docker-compose.yml), ENV_FILE (compose --env-file).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
compose=(docker compose -f "${COMPOSE_FILE:-docker-compose.yml}")
if [[ -n "${ENV_FILE:-}" ]]; then compose+=(--env-file "$ENV_FILE"); fi
psql=("${compose[@]}" exec -T postgres psql -U stillnote -d stillnote -q)

if [[ "${1:-}" == "--cleanup" ]]; then
  "${psql[@]}" <"$here/cleanup.sql"
  echo "Load-test data removed."
  exit 0
fi

"${psql[@]}" -v "users=${1:-500}" -v "notes_per_user=${2:-20}" <"$here/seed.sql"

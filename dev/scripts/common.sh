#!/usr/bin/env bash
# Shared helpers for the dev database scripts. Dev only.
set -euo pipefail
DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$DEV_DIR/docker-compose.yml"
# shellcheck disable=SC1091
set -a; source "$DEV_DIR/.env.dev"; set +a

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

wait_healthy() {
  local status
  for _ in $(seq 1 60); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$DB_AUDIT_MSSQL_CONTAINER" 2>/dev/null || echo missing)"
    if [ "$status" = "healthy" ]; then echo "container $DB_AUDIT_MSSQL_CONTAINER is healthy"; return 0; fi
    sleep 2
  done
  echo "container $DB_AUDIT_MSSQL_CONTAINER did not become healthy (last status: $status)" >&2
  docker logs --tail 40 "$DB_AUDIT_MSSQL_CONTAINER" >&2 || true
  return 1
}

# sqlcmd as sa inside the container. -C trust self-signed cert, -b fail on error,
# -I QUOTED_IDENTIFIER ON, -x keep $(...) tokens literal (Elastic Jobs commands use them).
sqlcmd_sa() {
  docker exec "$DB_AUDIT_MSSQL_CONTAINER" /opt/mssql-tools18/bin/sqlcmd \
    -S localhost -U sa -P "$DB_AUDIT_SA_PASSWORD" -C -b -I -x "$@"
}

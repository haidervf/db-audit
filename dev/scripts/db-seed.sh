#!/usr/bin/env bash
# Idempotent: each database script drops and recreates its database; the security
# script drops and recreates the dev logins. Dev only.
source "$(dirname "$0")/common.sh"
wait_healthy
run_seed() {
  local name="$1"; shift
  local out
  if ! out="$("$@" 2>&1)"; then
    echo "$out" >&2
    echo "seed $name FAILED" >&2
    exit 1
  fi
}
for f in "$DEV_DIR"/seed/*.sql; do
  name="$(basename "$f")"
  echo "seeding $name"
  if [ "$name" = "90_security.sql" ]; then
    # needs scripting variables, so no -x here (the file has no $(...) job tokens)
    run_seed "$name" docker exec "$DB_AUDIT_MSSQL_CONTAINER" /opt/mssql-tools18/bin/sqlcmd \
      -S localhost -U sa -P "$DB_AUDIT_SA_PASSWORD" -C -b -I -i "/seed/$name" \
      -v READER_PASSWORD="$DB_AUDIT_READER_PASSWORD" FULL_PASSWORD="$DB_AUDIT_FULL_PASSWORD" NOJOBS_PASSWORD="$DB_AUDIT_NOJOBS_PASSWORD"
  else
    run_seed "$name" sqlcmd_sa -i "/seed/$name"
  fi
done
echo "seed complete"
sqlcmd_sa -W -s '|' -i /seed/verify/counts.sql

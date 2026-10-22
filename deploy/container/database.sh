#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
export PGHOST="${PGHOST:-postgres}" PGPORT="${PGPORT:-5432}" PGDATABASE="${POSTGRES_DB:-plaingym}"
export PGUSER=maintenance PGPASSWORD="${MAINTENANCE_PASSWORD:?required}" PGCONNECT_TIMEOUT=5
case "${1:-}" in
  roles)
    psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $check$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app' AND rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
     OR NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'maintenance' AND rolcanlogin AND NOT rolsuper AND rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
     OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> 'maintenance'
     OR (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') <> 'maintenance'
     OR has_schema_privilege('app', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Database role bootstrap is missing or unsafe; refusing startup';
  END IF;
END $check$;
SQL
    # Verify the runtime credentials too; maintenance success alone is insufficient.
    PGUSER=app PGPASSWORD="${APP_PASSWORD:?required}" psql -X -v ON_ERROR_STOP=1 -q -c 'SELECT 1' >/dev/null
    ;;
  migrate|assert-empty)
    # TODO(CCR): replace the empty-schema guard with the shared migration CLI.
    # The scaffold has no schema. Never silently skip migrations on a populated DB.
    psql -X -v ON_ERROR_STOP=1 -q <<'SQL'
DO $check$
BEGIN
  IF EXISTS (
    SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
  ) OR EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')) THEN
    RAISE EXCEPTION 'This deployment adapter supports only the empty scaffold schema; migration/backup CLI integration is required';
  END IF;
END $check$;
SQL
    ;;
  dump) exec pg_dump --format=custom --compress=gzip:6 --no-owner ;;
  *) echo 'Usage: database.sh roles|migrate|assert-empty|dump' >&2; exit 2 ;;
esac

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
     OR EXISTS (SELECT FROM pg_namespace WHERE nspname = 'public' AND pg_get_userbyid(nspowner) <> 'maintenance') THEN
    RAISE EXCEPTION 'Database role bootstrap is missing or unsafe; refusing startup';
  END IF;
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'public') THEN
    IF has_schema_privilege('app', 'public', 'CREATE') THEN
      RAISE EXCEPTION 'Application role may not create schema objects';
    END IF;
  END IF;
END $check$;
SQL
    PGUSER=app PGPASSWORD="${APP_PASSWORD:?required}" psql -X -v ON_ERROR_STOP=1 -q -c 'SELECT 1' >/dev/null
    ;;
  migrate) exec node /app/maintenance.mjs migrate ;;
  dump) exec pg_dump --format=custom --compress=gzip:6 --no-owner ;;
  *) echo 'Usage: database.sh roles|migrate|dump' >&2; exit 2 ;;
esac

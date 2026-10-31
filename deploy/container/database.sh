#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
export PGHOST="${PGHOST:-postgres}" PGPORT="${PGPORT:-5432}" PGDATABASE="${POSTGRES_DB:-plaingym}" PGCONNECT_TIMEOUT=5
# Every command except `wait` connects as the maintenance role (BYPASSRLS).
maintenance() { export PGUSER=maintenance PGPASSWORD="${MAINTENANCE_PASSWORD:?required}"; }
case "${1:-}" in
  wait)
    # Postgres may still be starting, or restarting alongside the app. The readiness probe never
    # authenticates, so it needs no password; it names the app role.
    tries=0
    until PGUSER=app pg_isready -q; do
      tries=$((tries + 1))
      if [ "$tries" -ge 60 ]; then echo 'Database is not reachable; refusing startup' >&2; exit 1; fi
      sleep 1
    done
    ;;
  roles)
    maintenance
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
  migrate) maintenance; exec node /app/maintenance.mjs migrate ;;
  # Multi-gym mode's one-shot step: the app container never holds the maintenance role there, so this
  # runs the same checks and migrations to completion before the app starts (deploy/README.md).
  prepare)
    "$0" wait
    "$0" roles
    exec "$0" migrate
    ;;
  dump) maintenance; exec pg_dump --format=custom --compress=gzip:6 --no-owner ;;
  *) echo 'Usage: database.sh wait|roles|migrate|prepare|dump' >&2; exit 2 ;;
esac

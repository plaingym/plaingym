# SPDX-License-Identifier: AGPL-3.0-only
# Sourced by the official Postgres entrypoint; keep this file non-executable (0644).
(
set -eu
: "${APP_PASSWORD:?required}" "${MAINTENANCE_PASSWORD:?required}"

psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_PASSWORD
\getenv maintenance_password MAINTENANCE_PASSWORD
\getenv database_name POSTGRES_DB
BEGIN;
CREATE ROLE app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
CREATE ROLE maintenance LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'maintenance_password';
ALTER DATABASE :"database_name" OWNER TO maintenance;
REVOKE ALL ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO app;
ALTER SCHEMA public OWNER TO maintenance;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE maintenance IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
COMMIT;
SQL
)

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PlainGym

An AGPL-3.0-only gym application with first-boot setup, administration and kiosk
shells, and encrypted backups. See [the install guide](deploy/README.md).

## Local development

Use Node **24.22.1**, pnpm **10.34.7**, and Docker with Linux containers.

1. Copy `.env.example` to `.env` (UTF-8 without BOM).
2. Replace all three password placeholders with different random, URL-safe values.
   Update `DATABASE_URL` and `MAINTENANCE_DATABASE_URL` to match the app and
   maintenance passwords, database name and port.
   Set `SOURCE_URL` to the public source URL for your checkout.
   Generate independent `AUTH_SECRET` and `SETUP_TOKEN` values, and a 32-byte
   `APP_ENCRYPTION_KEY` encoded as 64 hex characters (`openssl rand -hex 32`).
3. Choose a unique `COMPOSE_PROJECT_NAME` and unused ports if another worktree is running.
4. Run:

```sh
pnpm install
pnpm dev:up
pnpm check-types
pnpm lint
pnpm test
pnpm dev
```

`pnpm dev:up` starts PostgreSQL and Mailpit and then runs `pnpm db:migrate`, which
applies migrations as the `maintenance` role (`MAINTENANCE_DATABASE_URL`); run
`pnpm db:migrate` again after pulling changes that add migrations.
On Windows use `pnpm.cmd` if PowerShell blocks `pnpm.ps1`. The server is at
`http://127.0.0.1:3000/healthz`, Vite at `http://127.0.0.1:5173`, and Mailpit at
`http://127.0.0.1:8025` with the example ports. Vite proxies `/healthz` to the
server's `PORT`. SMTP capture is on port 1025. All published ports bind to loopback.

On first boot, print the private setup link in another terminal and open it:

```sh
pnpm cli setup-link
```

The token is required to create the first owner or restore a backup. Backups
can be deferred with **Set up later**. Use `pnpm seed <gym-uuid>` to apply sample content.
`pnpm cli <command>` runs any server command with the root `.env`, as `gym-app <command>`
does in a deployed container.

`pnpm build` creates `apps/server/dist/server.mjs` with its adjacent `assets/`
and `apps/web/dist/`. Run the server with `pnpm --filter @plaingym/server start`
and preview the web build with `pnpm --filter @plaingym/web preview`.
Development runs the two apps separately.

`pnpm dev:stop` stops PostgreSQL and Mailpit and keeps the database; `pnpm dev:up`
starts them again. `pnpm dev:reset` removes this compose project's containers
**and database volume**.
Initialization runs only on an empty volume; changing passwords in `.env` does
not alter an existing database.

## Checks and boundaries

`pnpm install && pnpm test` works on a fresh clone with Node, pnpm, and Docker
running; no `.env` or manual database startup is needed, and tests never read
`.env` or your dev database. Tests split into two Vitest projects: `pnpm test:unit`
runs the files that need no database, without Docker; `pnpm test:integration`
runs the rest, and `pnpm test` runs both. For integration tests the setup starts a
unique, disposable PostgreSQL 18 compose project on a random loopback port,
bootstraps its roles, and removes its containers and volume after the run. It
starts only Postgres, not Mailpit. A test file belongs to the integration
project when it uses the `@plaingym/db/testing` helpers.

To use an existing test server instead, set `TEST_DATABASE_URL` (the `app` role),
with `TEST_MAINTENANCE_DATABASE_URL` and `TEST_DATABASE_ADMIN_URL`. CI supplies its
service database this way. A missing or unreachable database fails the run; no
tests silently skip. Tests silence the app's error log lines; `TEST_LOGS=1` shows
them. The smoke test reads PostgreSQL catalogs as `app`, checking role
privileges, ownership and DML-only defaults. It creates no tables.

ESLint limits vendor SDKs to server `infra/`. Within `apps/server/src/`, database
rules restrict raw handles outside core infrastructure and require portal/signed-link
access to use `forHousehold`. Core cannot import feature modules. Boundary tests
lint failing and permitted fixtures using the actual config. Schema imports and Drizzle query operators are permitted;
raw-handle restrictions target `@plaingym/db`, `packages/db/src/index`, and
`core/db` or `core/database`, along with the database client subpaths. Portal and
signed-link modules cannot import `forGym` from those or any `core/` module. Ordinary service barrels,
schema namespaces, and shared-contract namespaces remain available. Server runtime
imports are static and cannot use `createRequire`; frontend lazy imports and test
module reloads remain available.

`pnpm verify` runs types, lint, tests and compliance on a clean checkout and
records the tree it checked (in the shared `.git` directory, keyed by tree, Node
version and platform). The pre-push hook runs the same verification for the commit
being pushed, unless that tree is already recorded; deleting a remote branch pushes
no code and runs nothing. Pushing the same tree again, or a commit you verified
before, therefore never repeats the suite. On a push to `main`, CI likewise reuses
a passing run of the same commit (from its integration branch) instead of
repeating it. Local `pnpm install` installs or refreshes the hook automatically;
`pnpm hooks:install` can reinstall it manually.
Dependency lifecycle scripts are allowlisted for esbuild and the reviewed
simple-git-hooks installer only. Source archives and CI skip the root hook setup.

The server build copies the Noto Sans font and its [OFL notice](apps/server/src/assets/fonts/OFL.txt).
Tests boot a relocated bundle to check asset resolution and run a bundled
CommonJS dependency using a Node builtin. The web dev server includes React Fast Refresh.
`pnpm compliance` checks dependency licenses, SPDX headers and `THIRD_PARTY_LICENSES`
(see [scripts/compliance/README.md](scripts/compliance/README.md)).

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

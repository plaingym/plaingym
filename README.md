<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PlainGym

An AGPL-3.0-only gym application. This checkout contains a development scaffold:
a public `GET /healthz` Hono server and a minimal React page built by Vite.

## Local development

Use Node **24.22.1**, pnpm **10.34.7**, and Docker with Linux containers.

1. Copy `.env.example` to `.env` (UTF-8 without BOM).
2. Replace all three password placeholders with different random, URL-safe values.
   Update `DATABASE_URL` to match the app password, database name and port.
   Set `SOURCE_URL` to the public source URL for your checkout.
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

On Windows use `pnpm.cmd` if PowerShell blocks `pnpm.ps1`. The server is at
`http://127.0.0.1:3000/healthz`, Vite at `http://127.0.0.1:5173`, and Mailpit at
`http://127.0.0.1:8025` with the example ports. Vite proxies `/healthz` to the
server's `PORT`. SMTP capture is on port 1025. All published ports bind to loopback.

`pnpm build` creates `apps/server/dist/server.mjs` with its adjacent `assets/`
and `apps/web/dist/`. Run the server with `pnpm --filter @plaingym/server start`
and preview the web build with `pnpm --filter @plaingym/web preview`.
The development scaffold runs the two apps separately.

`pnpm dev:down` removes this compose project's containers **and database volume**.
Initialization runs only on an empty volume; changing passwords in `.env` does
not alter an existing database.

## Checks and boundaries

`pnpm install && pnpm test` works on a fresh clone with Node, pnpm, and Docker
running; no `.env` or manual database startup is needed. When `DATABASE_URL` is
unset, the test setup starts a unique, disposable PostgreSQL 18 compose project
on a random loopback port, bootstraps its roles, and removes its containers and
volume after the run. It starts only Postgres, not Mailpit.

An explicit `DATABASE_URL` (including one in `.env`) uses that database instead;
start it with `pnpm dev:up` if it is your dev stack. CI supplies its service
database this way. A missing or unreachable database fails the run; no tests
silently skip. The smoke test reads PostgreSQL catalogs as `app`, checking role
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

The pre-push hook runs types, lint and tests. Local `pnpm install` installs or
refreshes it automatically; `pnpm hooks:install` can reinstall it manually.
Dependency lifecycle scripts are allowlisted for esbuild and the reviewed
simple-git-hooks installer only. Source archives and CI skip the root hook setup.

The server build copies the Noto Sans font and its [OFL notice](apps/server/src/assets/fonts/OFL.txt).
Tests boot a relocated bundle to check asset resolution and run a bundled
CommonJS dependency using a Node builtin. The web dev server includes React Fast Refresh.
`pnpm licenses list` reports dependency licenses.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

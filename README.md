<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# PlainGym

An AGPL-3.0-only gym application with members and households, ranks and promotions,
class scheduling and kiosk attendance, imports and exports, waivers, signed links
and campaigns, Stripe billing, and encrypted backups.
See [the install guide](deploy/README.md).

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
server's `PORT`. SMTP capture is on port 1025. Docker's published ports bind to loopback.

On first boot, print the private setup link in another terminal and open it:

```sh
pnpm cli setup-link
```

The token is required to create the first owner or restore a backup. Backups
can be deferred with **Set up later**. Use `pnpm seed <gym-uuid>` to apply sample content.
`pnpm cli <command>` runs any server command with the root `.env`, as `gym-app <command>`
does in a deployed container.

### Sandbox demo over local HTTPS

The demo redirects to `https://<random>.demo.localhost/admin`, so it needs HTTPS
on port **443** alongside `pnpm dev`. In your root `.env`, set:

```dotenv
TENANCY=multi
DEMO_MODE=true
DEMO_DOMAIN=demo.localhost
PUBLIC_ORIGIN=https://demo.localhost
AUTH_PASSWORD_LOGIN=off
```

Also configure the `UPLOADS_S3_*` values from `.env.example`: demo seeds require
working S3-compatible storage even though visitor uploads are disabled. The
optional Stripe test billing settings are described in the [demo guide](apps/server/src/demo/README.md).
Start the database with `pnpm dev:up`, then run `pnpm dev`. In another terminal:

```sh
pnpm dev:proxy:up
pnpm dev:proxy:trust
```

Trust the CA once per machine/user, then **fully quit and restart Chrome** (or
your Chromium browser). Open **https://demo.localhost/demo** and click **Try the
demo**. Use that HTTPS address instead of `localhost:5173`; sandbox redirects,
secure cookies and Vite's HMR websocket then use the same origin on port 443.
No DNS or hosts-file changes are needed in Chrome/Edge for `.localhost` names.

`compose.dev-proxy.yaml` runs a pinned Caddy image, sharing its demo TLS/routing
configuration with the browser tests. It forwards to `host.docker.internal:5173`.
Docker Desktop can reach Vite's default loopback listener. If the proxy returns
502 on native Linux, set `VITE_HOST=0.0.0.0` in `.env` and restart `pnpm dev`;
this exposes the dev listener on other host interfaces, so use a trusted network.
Vite already accepts `.localhost` hosts and detects the proxied WSS port;
no `allowedHosts: true` or `hmr.clientPort` override is needed.
If Vite reports a port other than 5173, free 5173 and restart it.

The trust script exports **only the public root certificate** from
`/data/caddy/pki/authorities/local/root.crt` to the ignored
`data/dev-proxy/root.crt`, then installs it for the current user:

* **Windows:** `certutil -addstore -user Root data/dev-proxy/root.crt`.
* **macOS:** `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db data/dev-proxy/root.crt`.
* **Linux (Chrome/Chromium):** install your distribution's NSS `certutil` tool
  (`libnss3-tools` on Debian/Ubuntu). The script initializes the user's NSS DB if
  needed and imports with `certutil -d sql:<db> -A -t 'C,,' -n <nickname> -i data/dev-proxy/root.crt`.
  It uses `~/.pki/nssdb` if that directory exists, otherwise
  `~/.local/share/pki/nssdb`, following [Chromium's trust-store rules](https://chromium.googlesource.com/chromium/src.git/+/refs/heads/main/docs/linux/cert_management.md).

For tools such as curl, `pnpm dev:proxy:trust --export` just exports the root;
use `curl --cacert data/dev-proxy/root.crt https://demo.localhost/demo`.

`pnpm dev:proxy:stop` removes the proxy container and network, keeping the named
volume **`plaingym-dev-proxy-caddy-data`**. The CA survives restarts and worktree
changes. This proxy is shared locally: only one instance can bind port 443.
If 443 is already in use, stop the other proxy/service or this proxy before
running browser tests. Changing the port alone does not fix demo redirects,
which deliberately use the standard HTTPS port.

To remove trust, keep the exported certificate and run `pnpm dev:proxy:untrust`
(the container can be stopped). This deletes that CA by fingerprint on Windows
(`certutil -delstore -user Root <SHA1>`) and macOS
(`security delete-certificate -t -Z <SHA1> ~/Library/Keychains/login.keychain-db`),
or by its fingerprint-based nickname in Linux NSS (`certutil -d sql:<db> -D -n <nickname>`).
Restart Chrome again. To discard the CA entirely, stop the proxy and run
`docker volume rm plaingym-dev-proxy-caddy-data`; the next start creates a new
CA that must be trusted again.

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

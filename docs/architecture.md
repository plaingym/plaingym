<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Architecture

PlainGym is one Node.js server, one PostgreSQL database and a file store. The
server answers the JSON API, serves the staff admin, member portal, kiosk and
setup wizard as one single-page app, renders the public pages on the server, and
runs background jobs in the same process. There is no queue service, no cache
service and no separate worker.

This page is the map. The details live next to the code, in the READMEs it links.

## Processes and containers

A self-hosted install runs three containers from `deploy/compose.yaml`:

| Container | Role |
| :--- | :--- |
| `caddy` | The only container with published ports. Terminates TLS (automatic certificates), forwards to the app. |
| `app` | The PlainGym server (`apps/server`, bundled to `server.mjs`), with the built web app beside it. Runs as `node` on a read-only root filesystem with all capabilities dropped and no Docker access. |
| `postgres` | PostgreSQL 18 on an internal network that only the app can reach. |

The app's state is the database plus one data volume holding uploads and backup
staging (or an S3-compatible bucket for uploads). Several identical app processes
can share one database: job workers coordinate through the `jobs` table, and
process memory holds only short-lived state such as the general flood-protection counters.
Public intake budgets count atomically in PostgreSQL across processes, enabled by
`registerIntakeRateLimits` at startup. Named budgets separate join submissions,
admissions, payment/mail steps, trial/drop-in submissions and admissions, signed-link
claims, portal invitation acceptance and claim completion, staff invitation acceptance,
demo creation and demo login. Counters contain only the gym ID (null for
install-level requests), route budget, client address key, window and count. The
system-only table uses forced RLS and an hourly system job removes expired windows in
short batches. Each process also remembers, in memory, the budgets the database has
refused until their window ends, so a client over its limit costs no further database
work there.

On start, the container entrypoint (`deploy/container/`) checks the database roles,
resumes an interrupted restore and applies migrations as the `maintenance` role,
then starts the server as the `app` role. In multi-gym mode a separate one-shot
`migrate` service does that step instead, so the long-running app never holds the
maintenance credentials (`deploy/README.md`, "Which process holds the maintenance role").

## Repository layout

| Path | What it holds |
| :--- | :--- |
| `apps/server/src/core/` | Server composition: the app factory, tenant resolution, CSRF, CSP, rate limits, the route and job registries, and `runtime.ts`, which wires every area to real infrastructure. |
| `apps/server/src/areas/` | One folder per feature area: `members`, `staff`, `ranks`, `schedule`, `bookings`, `attendance`, `kiosk`, `portal`, `imports`, `billing`, `waivers`, `links`, `announcements`, `dashboard`, `reports`, `leads`, `health`, `settings`, `setup`, `public`. Each exports its routes and jobs. |
| `apps/server/src/infra/` | The only code that talks to outside systems: `auth` (Better Auth), `jobs` (the PostgreSQL queue), `email` (SMTP), `payments` (Stripe), `storage` (local disk and S3), `pdf`, `age` (backup encryption). |
| `apps/server/src/public/` | Server-rendered public pages (`/join`, `/trial`, `/drop-in`) and signed-link pages (`/l/*`). |
| `apps/server/src/modules/` | Optional feature modules a gym can switch off; today the public website. |
| `apps/server/src/cli/` | `gym-app` commands: setup link, owner password reset, gym creation (multi-gym mode), migrate, restore, webhook replay. |
| `apps/server/src/demo/` | Demo mode: sandbox gyms with sample data. Not loaded unless `DEMO_MODE=true`. |
| `apps/web/` | The React app for `/admin`, `/portal`, `/kiosk`, `/setup` and `/login` (`apps/web/README.md`). |
| `packages/db/` | Drizzle schema, generated migrations, the security SQL, and the only code that opens database connections (`packages/db/README.md`). |
| `packages/shared/` | Zod contracts shared by server and web, the permission maps, time helpers and the registry types (`packages/shared/README.md`). |
| `packs/` | Content packs: rank systems, suggested programs and class tags, as versioned JSON (`packs/README.md`). |
| `locales/` | Translation catalogs, validated by `pnpm generate`. |
| `deploy/` | Dockerfile, Compose file, Caddyfile, installer and updater (`deploy/README.md`). |
| `e2e/` | Browser tests against the production image, and the VM test fixture (`e2e/README.md`). |

## Surfaces and routes

| Path | Surface |
| :--- | :--- |
| `/` | The gym's public website when the website module is on; otherwise a redirect to `/portal`. |
| `/programs`, `/schedule`, `/plans`, `/coaches`, `/contact`, `/sitemap.xml`, `/robots.txt`, `/website/*` | The rest of the public website, its search-engine files, theme and photos. Only while the website module is on; 404 otherwise. |
| `/join`, `/trial`, `/drop-in` | Public sign-up, trial and drop-in pages. Always on. |
| `/l/*` | Signed-link pages: pay an invoice, update a card, sign a waiver, onboarding, announcement preferences. |
| `/webhooks/stripe` | The Stripe webhook inbox. |
| `/admin` | Staff admin. |
| `/portal` | Member portal, an installable PWA. |
| `/kiosk` | Check-in kiosk, authenticated by a device token. |
| `/setup` | First-boot setup wizard (single-gym mode). |
| `/api` | JSON API. `/api/openapi.json` is the generated OpenAPI document. |
| `/healthz`, `/api/source`, `/source` | Liveness and the running release's source link. |

## A request

`core/app.ts` mounts the server in this order:

1. **Request ID and body limits.**
2. **Install routes** that need no gym: liveness, source metadata, CSP reports, and
   the first-boot setup endpoints (behind the setup token, with their own CSRF
   check and rate limit).
3. **Restore gate.** While a restore holds the install, everything after this
   point waits or fails.
4. **Static assets**, so an empty install can still load `/setup`.
5. **Rate limit** (single-gym mode) per client address, install-wide. The install
   serves one gym for any hostname, so this is the same budget as per gym, and
   running it before the lookup means a refused request costs no database work.
6. **Tenant resolution** (`core/tenancy.ts`). Single-gym mode takes the install's
   one gym; multi-gym mode looks up the request's `Host` in `gym_domains`. No gym,
   or an inactive one, is a 404. Multi-gym mode then applies its **rate limit**
   per gym and client address.
7. **Session loading.** A staff or member session from Better Auth, a kiosk device
   token, or a signed-link token, each bound to the resolved gym.
8. **CSRF.** Cookie-authenticated writes need a matching `Origin`.
9. **The route.** Every route is registered through `route()` in
   `core/registry.ts`, which requires a declared permission (see
   [security-model.md](security-model.md)). The handler validates its input with
   the shared Zod contract and reads data through `forGym` or `forHousehold`.

Responses use `{ data }`; errors use `{ error: { code, message }, requestId }`.

## Areas, contracts and registries

Each area folder exports `routes` and `jobs` arrays that `core/registry-areas.ts`
collects. A route's request and response types come from a contract in
`packages/shared/src/contracts/`, so the server, the web client and the OpenAPI
document share one definition. Areas talk to each other through the interfaces in
`apps/server/src/core/interfaces/` (projections and aggregates, never database
handles), each with an in-memory fake for tests.

`core/runtime.ts` is the one place that builds real services: it gives each area
its infrastructure (storage, email, payments, the job queue, the clock) and
replaces placeholder routes with configured ones (setup's placeholders answer
503 "not configured" until it does).

Optional modules (`apps/server/src/modules/`) own their schema, routes and UI,
sit behind a per-gym switch in `gyms`, and are never imported by core. The
registry checks the switch on every request and job, so a module's routes answer
404 while the gym has it off. A module keeps small per-gym settings through
`areas/settings/module-settings.ts`, which saves them in the gym's settings under
the gym revision and audits each save. The public website
(`apps/server/src/modules/website/README.md`) is the first module.

## Data

PostgreSQL holds everything except file contents. The rules that matter most:

* Every gym-owned table has `gym_id`, row-level security forced on, and composite
  foreign keys that include `gym_id`, so a row can't point at another gym's row.
* The app connects as `app` (no `BYPASSRLS`); `maintenance` runs migrations,
  backups and restore.
* Migrations are generated by drizzle-kit and are expand/contract: a column is
  never dropped in the release that stops using it. Patch releases carry no
  migrations.
* Money is an integer in the currency's minor units, as Stripe takes it (cents
  for USD, whole yen for JPY, fils for KWD), with a currency. Any currency is
  accepted; `@plaingym/shared/money` holds each currency's decimal places and is
  the only code that converts amounts for display or from a typed price. Prices,
  invoice totals and card refunds land on the step Stripe charges in (whole units for
  ISK and UGX, a last digit of 0 for the three-decimal currencies); a saved-card
  charge below Stripe's minimum, or off the step, is skipped and left for a manual payment.
  Timestamps are `timestamptz`; billing dates are computed in the gym's timezone.
* Secrets stored in the database (Stripe keys, SMTP passwords, backup credentials,
  the gym's QR key) are encrypted with `APP_ENCRYPTION_KEY`.
* State changes write an `audit_events` row.

The table inventory, the security SQL and the scoped-access helpers are in
`packages/db/README.md`.

## Background jobs

Jobs live in the `jobs` table and run in the server process (`infra/jobs/README.md`).
Workers claim with `FOR UPDATE SKIP LOCKED`, hold a 30-second lease with a
heartbeat, and run at most one job per gym and lane at a time (four per
process), so one gym's backlog never starves another. Long batch work (the daily
charge run, imports, exports, campaigns) runs in its own lane beside the gym's
other jobs. Jobs are at-least-once, so every
external effect uses an idempotency key. Cron schedules are evaluated per gym in
the gym's timezone. Finished jobs are pruned on a retention schedule.

Producers that need a job to commit with application writes use
`withJobTransaction(forGym, gymId, callback)` and pass its caller transaction to
`Jobs.enqueue` as the optional fourth argument. Enqueue uses that same gym-scoped
handle for insertion and deduplication; ordinary enqueue inside a transaction is
rejected. The last household member's erasure queues customer redaction this way,
then calls the payment provider after commit.

## Billing

Billing uses the gym's own Stripe account. The local `invoices` table is the
source of truth; Stripe is the processor. In outline:

* **Catalog and memberships** (`areas/billing/catalog.README.md`,
  `memberships.README.md`): plans, charge types, tax rates, memberships; the
  [class pack catalog](../apps/server/src/areas/billing/packs/README.md) manages
  revision-checked pack prices and tax links. Staff sell packs as one-off invoices;
  zero-total sales settle immediately, payment grants credits and a full refund
  reverses unused credits. Live check-ins spend one credit under the member lock
  unless an active or trial membership covers the visit; imports never spend.
  All staff may undo a live attendance through `attendance.manage`, deleting the
  visit and returning any spent credit to its original lot in one audited
  transaction. The kiosk refuses an exhausted pack holder with a neutral
  front-desk message; staff may still record the visit without a credit.
* **Invoicing** (`areas/billing/invoicing/`): pure calculation of invoice lines and tax.
* **Charge runner** (`areas/billing/runner/`): the daily run charges saved cards in
  two steps (create, then confirm) with idempotency keys, retries on the gym's
  schedule, and reconciles uncertain attempts with Stripe by ID.
* **Transitions** (`areas/billing/transitions/`): the only code that changes invoice
  state; its effects (receipts, dunning, membership activation, class credit grants
  and full-refund reversals)
  run as jobs.
* **Webhook inbox** (`areas/billing/webhooks/`): verify the signature, store the
  event once, process it in a job.
* **Signed links and campaigns** (`areas/links/`): pay, update-card, waiver and
  onboarding links, sent one at a time or as a campaign.
  Announcement unsubscribe links (`areas/announcements/unsubscribe.ts`) are
  minted inside their caller's transaction and excluded from staff link actions.
  Their page and strict one-click POST change only the linked member's separate
  announcement preference through `forHousehold`.

Cards are collected only on Stripe-hosted pages; the app stores processor IDs,
never card numbers.

## Infrastructure modules

Waiver versions contain either text or an immutable uploaded PDF reference.
The waiver module validates PDF uploads through `infra/pdf/document.ts` and stores
their bytes through `Uploads`. Signing snapshots retain the original reference,
hash, page count and size; signed copies copy those pages and append generated
signing details. Reads never substitute a newer template. Document delivery uses
an injected stable signer and canonical gym origins: short-lived, gym-bound app
URLs give local and S3 storage the same response headers. See
[`areas/waivers/README.md`](../apps/server/src/areas/waivers/README.md) for composition.

Third-party SDKs are imported only inside `apps/server/src/infra/` (lint-enforced).
Each module has an interface, a production adapter and a fake, and a shared
contract suite runs against both (`core/registry-infra-contracts.ts`):

| Module | Production adapter |
| :--- | :--- |
| `auth` | Better Auth: sessions, magic links, passwords, optional Google sign-in (`infra/auth/README.md`) |
| `jobs` | PostgreSQL queue (`infra/jobs/README.md`) |
| `email` | Nodemailer over SMTP, with durable per-message send state (`infra/email/README.md`) |
| `payments` | Stripe, on the gym's own keys (`infra/payments/README.md`) |
| `storage` | Local disk or an S3-compatible bucket, plus the backup destination (`infra/storage/README.md`) |
| `pdf` | Bounded PDF rendering with pinned fonts (`infra/pdf/README.md`) |

None of them may be called inside a database transaction: services reserve and
commit, call out, then record the outcome in a new transaction.

## Tenancy modes

`TENANCY=single` (the default) serves one gym, created by the setup wizard, on
one hostname. `TENANCY=multi` serves several gyms from one install: each is
created with `gym-app gyms create` and resolved by its hostname. Multi-gym mode
requires S3 uploads and install-wide SMTP, refuses password sign-in, and has no
in-process backups or restore. The code and schema are the same in both modes,
and no feature reads across gyms.

## Testing

Unit tests need no database; integration tests run against a real, disposable
PostgreSQL. The billing scenario suite (`areas/billing/scenarios/`) drives whole
billing flows through the fakes and, optionally, Stripe test mode. End-to-end
tests run the production image in Docker with a browser (`e2e/README.md`). A memory check
runs the shipped Compose stack under load and fails over its budget (`deploy/test/memory/README.md`).
`pnpm verify` runs types, lint, compliance and the tests a branch affects; CI runs
the full suite. See the root `README.md`, "Checks and boundaries".

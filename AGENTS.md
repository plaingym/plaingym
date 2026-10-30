# Open-Source Contributor & Agent Guidelines (`AGENTS.md`)

Welcome! You are an AI agent or contributor developing the open-source gym management app.

---

## 1. Project Philosophy

This project is a 100% open-source (AGPL-3.0-only), vendor-neutral, all-in-one gym management app. One install runs an entire gym: staff admin, member management, class scheduling, booking and attendance, ranks and promotions, a member portal, a check-in kiosk, billing, waivers, and an optional public website.

* **Tenant-Aware, One Gym per Install by Default:** The app runs in two tenancy modes with identical code and schema. `TENANCY=single` (default) serves exactly one gym; `TENANCY=multi` serves several gyms from one install, each resolved by its hostname and created with the CLI. Every gym-owned table carries `gym_id`, and gyms are strictly isolated (see "Tenant Isolation & Authorization" below).
* **Per-gym features only:** Tenancy means isolation, never cross-gym features. No feature may read or combine data across gyms.
* **Zero Vendor Lock-in:** The software must run anywhere Docker runs (amd64 and arm64). No proprietary cloud dependencies.
* **Self-Hosting First:** `docker compose up -d` (Caddy + app + PostgreSQL) launches everything. Owners run the gym from the web admin; the command line is only for install, minor/major updates, and owner lockout. No Redis, no PaaS.
* **Open Standards:** Standard Web Request/Response APIs, SQL, and a documented OpenAPI REST/JSON API.
* **Discipline-Agnostic Core:** No code or schema enum may assume a specific martial art or training style. Belts, stripes, kyu/dan grades, programs, and class tags live in content packs (`packs/*`, versioned JSON): rank systems, suggested programs, and class tags.
* **Modules Depend on Core, Never the Reverse:** Feature modules (starting with the public website) own their schema file, routes, and UI folder, sit behind a per-gym toggle in `gyms`, and can be disabled without breaking core.

---

## 2. Technical Stack & Architecture

* **Runtime & Tooling:** Node.js LTS (pinned in `.nvmrc` and `engines`), pnpm workspaces, Vitest, `tsc --noEmit`; `tsx` in development, esbuild bundles the server
* **API Framework:** Hono (`@hono/node-server`) + `@hono/zod-openapi`
* **Public Website:** Server-rendered Hono JSX + Tailwind (no meta-framework)
* **Admin / Member Portal / Kiosk:** React + Vite + Tailwind CSS + shadcn/ui (SPA served by the app server; the portal is an installable PWA)
* **Database:** PostgreSQL (one pinned major version), with row-level security for tenant isolation
* **ORM & Migrations:** Drizzle ORM (`postgres.js` driver) + drizzle-kit
* **Authentication:** Better Auth (Drizzle adapter, identity + sessions only). Google OAuth + Email Magic Link when SMTP is configured; Email + Password when SMTP is unconfigured (`AUTH_PASSWORD_LOGIN=auto|on|off`). Console-logged magic links are dev-only.
* **Data Validation:** Zod (shared between frontend, API routes, and the OpenAPI spec)
* **Background Jobs:** Own Postgres `jobs` table + in-process worker with `SKIP LOCKED` claiming and per-gym concurrency caps (do not add an external queue or Redis)
* **Payments:** Stripe, using the gym's own API keys (webhook endpoint auto-registered during setup)
* **Email:** Nodemailer over plain SMTP (any provider) + React Email templates; Mailpit in the dev compose stack
* **File Storage:** Local disk by default; any S3-compatible bucket via config (required in `multi` mode). Keys are prefixed by `gym_id`. Never store files or images in the database.
* **Backups:** Built-in encrypted `pg_dump` snapshots to S3 (run as the `maintenance` role), each with a recovery bundle holding `APP_ENCRYPTION_KEY` under the backup key; restore from the setup wizard or CLI re-encrypts stored secrets for the new install
* **Reverse Proxy / TLS:** Caddy

### Route Layout
| Path | Surface |
| :--- | :--- |
| `/` | Public gym website (server-rendered) when the website module is enabled; otherwise redirects to `/portal` |
| `/join`, `/trial`, `/drop-in` | Core public pages (always on, independent of the website module) |
| `/l/*` | Signed-link pages: one purpose, one resource, expiring |
| `/webhooks/stripe` | Stripe webhook inbox (signature-verified) |
| `/portal` | Member portal (SPA, installable PWA): booking, QR check-in code, progress, invoices, waivers, household |
| `/admin` | Staff admin (SPA) |
| `/kiosk` | Check-in kiosk (SPA, device token) |
| `/api` | JSON API |

### Deployment Shape
* One app process (API + public site + SPA + job worker) plus PostgreSQL and an uploads directory. Keep the app stateless: several identical processes must be able to share one database, with job workers coordinating through the `jobs` table.
* The public website is an optional runtime feature, not a separate service. Every feature must work with the website disabled.
* A self-hosted install (Caddy + app + tuned Postgres) must run in 1 GB RAM with swap (< ~250 MB idle, < ~600 MB peak); 2 GB recommended. Releases are prebuilt; never require building on the server.
* Releases are semver-tagged, multi-arch Docker images with a signed release manifest. Installs never track `latest`. Compose sets Docker log rotation.
* **Patch releases (x.y.Z) must not contain migrations**; installs apply them automatically each night with rollback. CI enforces this.
* The app must never require Docker socket access.
* **Demo mode** (`DEMO_MODE=true`, with `TENANCY=multi`) lets visitors create sandbox gyms seeded with sample data, deleted after 24 hours. It sends no email (an in-app outbox instead), disables general visitor uploads, and refuses to start with live Stripe keys. Validated waiver signatures have a bounded, audited upload path; signature images and bounded waiver PDFs are stored in S3. Sandbox creation and one-click logins exist only in demo mode.

### Vendor Modules
Third-party services are only ever accessed through these internal modules. Never import a vendor SDK elsewhere:

| Module | Interface |
| :--- | :--- |
| `auth` | `getSession(req) → { userId } \| null` (roles live in our `staff_roles` / household tables) |
| `jobs` | `enqueue(name, payload, opts)`, `handle(name, fn)`, `schedule(name, cron, fn)` |
| `email` | `sendEmail({ to, subject, html, text, replyTo })` |
| `payments` | `createCustomer`, `createCharge` (unconfirmed PaymentIntent), `confirmCharge`, `cancelCharge`, `findCharge`, `listRefunds`, `readPaymentObject`, `listChangesSince`, `refund`, `createCheckout`, `expireCheckout`, `findCustomerByEmail`, `adoptCustomer`, `detachPaymentMethod`, `redactCustomer`, `parseWebhook` (webhook verification lives in the provider, not the inbox) |
| `pdf` (`infra/pdf`) | `renderPdf` renders bounded documents with pinned fonts; `missingGlyphs` reports unsupported code points |
| `storage` | Uploads: `put` (new immutable key, never overwrites), `get`, `head`, `list`, `signedUrl`, `markDeleted`, `sweep`. Backup destination: multipart `putObject` (aborted on failure), `getObject`, `headObject`, `listObjects`, `deleteObject` |
| db client | `packages/db/src/client.ts` is the only file that opens the database; app code gets a handle only via `forGym(gymId)` |

Prefer Web-standard APIs (`fetch`, `Request`/`Response`, WebCrypto, Web Streams) over Node-specific ones where both work; Node built-ins are fine inside these modules.

---

## 3. Strict Coding Rules

### 1. Tenant Isolation & Authorization
**RULE:** A gym must never see another gym's data, and a member must never see another household's data. Both are zero-tolerance bugs.

#### 1.1 Gym ↔ Gym
* All data access goes through `forGym(gymId, fn)`, which runs `fn` in one short transaction with `app.gym_id` set. Importing the raw `db` client outside `packages/db` and core infrastructure is lint-restricted.
* Every table has `ENABLE` + `FORCE ROW LEVEL SECURITY`. Gym-owned tables have a policy on `app.gym_id`. The **system tables** listed in `packages/db` (`gyms`, `gym_domains`, `jobs`, `auth_*`, `backup_runs`, `stripe_events`) have policies for two contexts: inside `forGym` a gym sees only its own system rows, and infrastructure uses system context (`forSystem`, or the auth adapter's `systemDatabase()` pool), which grants no gym-owned data; with neither context nothing is visible. Each listed table states why it is a system table, its access kind, and which core modules may touch it or use system context (lint-enforced), and has its own access tests. CI fails if any table's policies, `ENABLE`, or `FORCE` differ from what it declares, or if a table without `gym_id` isn't on the list. This guards against accidental unscoped queries; explicit system context is trusted and lint-restricted.
* The app connects as the `app` role, without `BYPASSRLS` and never as a superuser. The `maintenance` role (`BYPASSRLS`) is used only by migrations, backups, and restore.
* References between gym-owned tables include `gym_id` (composite foreign keys), so a row can never point at another gym's row.
* Job handlers receive the job's gym as context and open their own short `forGym` transactions.
* Only allowlisted Better Auth endpoints are reachable; there is no endpoint that lists or bulk-revokes sessions. Sessions, magic-link tokens, and OAuth state are bound to the gym that issued them and checked against the request's resolved gym before use.
* Add cross-gym tests (gym A → 404 on gym B's resources) for every new gym-owned route.

#### 1.2 Member ↔ Member
* Every route declares its required permission: a staff role (`owner`, `admin`, `coach`, `front_desk`) or member access (a portal login linked to a household). Unauthenticated access is opt-in per route.
* Members reach the app through the member portal, signed links, the kiosk (name/PIN or QR code), and the public pages; none of these may expose another household's data.
* Portal and signed-link routes access data only through `forHousehold(householdId)`; importing the raw `db` client or `forGym` there is lint-restricted.
* Within a household, only the payer sees invoices, payment methods, and other household members; an adult member who isn't the payer sees only their own data.
* QR check-in codes are per member, revocable, and resolve only within their own gym. They are derived from gym, member, and a version number with the gym's own random key (stored encrypted, so codes survive a restore), so any device can show them; only their hash is stored.
* Staff-initiated password resets only reach users whose roles are all below the resetter's; a member who is also staff counts as staff, and owners reset their own password only through the CLI. `TENANCY=multi` refuses password login.
* The kiosk authenticates with a revocable device token limited to check-in endpoints, never a staff session.
* Signed, expiring links grant access to exactly one resource.
* Add cross-member access tests (household A's login, link, PIN, or QR code → 403/404 on household B's resources) for every new member-facing route.

### 2. Schema-Driven Development
* All database changes must be authored via Drizzle schema definitions (`packages/db/src/schema`).
* Generate migrations via `drizzle-kit generate`. Do not write arbitrary manual SQL migrations outside Drizzle.
* drizzle-kit can't express `FORCE ROW LEVEL SECURITY` or grants, so reviewed security SQL in `packages/db` handles them: database bootstrap creates the `app` and `maintenance` roles and sets default privileges, and after migrations (before the app reports ready) an idempotent step forces RLS on every table that has it enabled and re-applies the declared `REVOKE`s. Never re-grant table privileges wholesale. The same setup runs in production, on restored installs, and on the test database template; a CI catalog check verifies policies, `ENABLE`/`FORCE`, and restricted privileges.
* Migrations must be **expand/contract**: never drop or rename a column in the same release that stops using it. Users skip versions.
* Every gym-owned table has `gym_id uuid not null`, leading its indexes and unique constraints (e.g. `(gym_id, email)`).
* Primary keys are UUIDv7 in native `uuid` columns, generated in app code. Never expose sequential IDs.
* Store money as integer cents with an explicit `currency` column. Store timestamps as `timestamptz`. Compute billing dates in the gym's IANA `timezone`. Convert between local times, calendar dates, and instants only with `@plaingym/shared/time`; formatting for display may use `Intl` directly.
* Enums are `text` with `CHECK` constraints; structured data uses `jsonb`.
* Secrets stored in the database are encrypted with `APP_ENCRYPTION_KEY`.
* State-changing service calls write an `audit_events` row.
* Share Zod validation schemas across API routes, frontend forms, and the OpenAPI spec.

### 3. PostgreSQL Rules
* Keep transactions short. Batch work (charge runs, imports) commits in small chunks so one gym never holds locks others wait on.
* **No network I/O inside a transaction** (Stripe, SMTP, S3, outbound HTTP). Read or reserve and commit, then call out, then record the outcome in a new transaction. The `payments`, `email`, and `storage` modules throw if called inside one.
* Use Drizzle's query builder. Raw SQL (full-text search, job claiming, RLS setup) only in clearly marked, isolated spots.
* Correctness never depends on timing: use idempotency keys, unique constraints, or an explicit row lock (`SELECT … FOR UPDATE`) taken inside one short transaction. Booking capacity is enforced by locking the session row for every booking change.
* Never store file contents or images in the database.

### 4. Payment & Billing Safety
* Never store raw credit card numbers or PANs. Only store tokenized processor IDs (e.g., `pm_xxx`). Collect cards via Stripe-hosted pages.
* The local `invoices` table is the billing source of truth.
* Webhooks use the inbox pattern: verify → insert into `stripe_events` (dedupe on `event.id`) → process in a job. Handlers must be idempotent.
* A `pending` `payment_attempts` row, with its immutable request parameters, is committed before Stripe is called. Charges run in two steps: create an unconfirmed PaymentIntent (idempotency key `invoice_id:attempt_n:create`), commit its ID with a compare-and-set that succeeds only while the attempt is still `pending` and unresolved, then confirm it (`invoice_id:attempt_n:confirm`). A worker whose compare-and-set fails cancels its intent and never confirms. Attempts whose outcome is unknown are reconciled with Stripe by ID, never retried blind (idempotency keys can expire) and never decided by Stripe's search, which lags.
* Recognize `authentication_required` from thrown errors and `last_payment_error`, including when the intent is `requires_payment_method`.
* Only the invoice transitions change invoice state, and they only move forward: a `paid` invoice ignores later failures, stale errors, and out-of-order events for older attempts. Webhook arrival order is not lifecycle order.
* Maintain tests for successful/failed charges, SCA (`authentication_required` and `requires_action`), webhook replay, crash-and-reconcile, and dunning.
* Billing and authorization tests run against a real PostgreSQL database (fresh per test file), not database mocks.

### 5. UI & Component Standards
* **Mobile-first:** build every screen for a 360 px wide phone first and scale up to tablet and desktop (Tailwind base classes for the phone layout, `sm:` / `md:` / `lg:` for larger screens). No horizontal page scrolling; touch targets at least 44 px; text readable without zooming; wide tables become stacked rows or scroll inside their own container; navigation collapses into a menu. The kiosk is tablet-first but must still work on a phone. Check every screen you build or change at 360 px and on desktop. Conventions and shared components: `apps/web/README.md`.
* Use `shadcn/ui` components located in `apps/web/src/components/ui`.
* Never write custom CSS files if Tailwind utility classes can achieve the same result.
* The check-in kiosk (`/kiosk`) must be tablet/touch-friendly and work smoothly in full-screen browser mode.
* Public website pages are server-rendered Hono JSX; do not add client-side hydration frameworks.

### 6. Licensing
* Application code is **AGPL-3.0-only**. Every new source file starts with an SPDX header: `// SPDX-License-Identifier: AGPL-3.0-only` (use the file type's comment syntax).
* **Dependency allowlist:** MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, MPL-2.0, CC0-1.0, Unlicense, BlueOak-1.0.0. Scoped allowances: **CC-BY-4.0** for build-time packages only (never bundled into the runtime), and **OFL-1.1** for font files only. Required notices go in `THIRD_PARTY_LICENSES`. The license check evaluates compound SPDX expressions and reads a package's LICENSE file when its manifest omits the license field. Anything else (e.g. GPL-2.0-only, EPL without a GPL secondary-license notice, SSPL, BUSL, CC-NC, proprietary) needs explicit maintainer approval; the CI license check blocks it by default.
* **AGPL §13 (network use):** the app always shows a "Source code" link (admin footer and public pages) pointing to the running release's tag. `SOURCE_URL` overrides it for modified installs. Never remove or hide this link.
* Releases ship a generated `THIRD_PARTY_LICENSES` file covering bundled dependencies, including the Node.js runtime and system packages in the Docker image.

---

## 4. Pull Requests & AI Contributions
* **Branches.** `main` is the only long-lived branch. Work on a short-lived branch from `main`, focused on one change. Each change lands on `main` as one squashed conventional commit, after type checking, lint, and tests pass. Outside contributions arrive as pull requests against `main`.
* **Contributor License Agreement.** Contributors keep their copyright and sign [`CLA.md`](CLA.md) once, by replying to the CLA check on their pull request, before their first pull request is merged; the CLA check must pass. No copyright assignment. See `CONTRIBUTING.md`.
* Ensure all TypeScript code passes strict type checking: `pnpm check-types` (`tsc --noEmit`).
* Ensure all linter rules pass: `pnpm lint`.
* Ensure tests pass: `pnpm test` (Vitest, against a real PostgreSQL).
* Provide clear, atomic commit messages following conventional commits (`feat:`, `fix:`, `refactor:`, `docs:`).
* Do not add AI session trailers or attribution links (e.g., `Claude-Session:` lines or claude.ai session URLs) to commit messages or PR descriptions.

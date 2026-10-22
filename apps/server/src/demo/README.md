<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo mode

The demo service creates a separate gym per visitor with a random hostname, seeded
content packs, owner/coach/student identities, and one kiosk device. It never calls
`gyms create` or sends a bootstrap email. The API returns the kiosk token once;
only its SHA-256 hash is stored. Ready sandboxes do not retain bootstrap email.

`DEMO_MODE=true` requires `TENANCY=multi`, `DEMO_DOMAIN` (a lowercase hostname with
wildcard DNS/TLS), and optionally `DEMO_MAX_SANDBOXES` (1–1000, default 50).
`demoBootCheck` rejects live Stripe keys in the environment; `verifyDemoStoredKeys`
also decrypts and checks existing gym Stripe configuration before startup.

The cap uses unique `sandbox-1` through `sandbox-N` slugs, so it holds across app
processes and concurrent requests. Failed or unfinished allocations occupy a slot
until deletion. Their temporary reservation marker lets expiry recover a crash
between audited gym reservation and seeding. Creation is limited to three requests
per client address per hour, per process; login to 20 per minute per gym/address.
Untrusted forwarded headers do not change the bucket. Use the trusted-proxy options
when Caddy is the sole peer. Configure the same cap on every app process.

`OutboxEmail` implements `Email` with no SMTP dependency. It records text and HTML,
never delivers to an external mailbox, and rejects calls inside transactions.
The outbox is owner/admin-only, uses cursor pagination, and scopes detail IDs to
the current gym. Its HTML preview disallows scripts and network requests.

Identities use the existing account provisioner and auth service. Demo login captures
and consumes a request-local magic link without an email transport, then returns the
normal signed, secure, host-only auth cookie. It never implements another session
format. Student data is linked to a household; staff roles stay in `staff_roles`.

Gym deletion checks revision and suspends the gym before cleaning uploads outside a
transaction. A storage error leaves a suspended gym that an install cleanup job can
retry. A single gym deletion cascades all rows carrying its `gym_id`, including jobs,
sessions and audits. Deleting a sandbox also removes its three deterministic
`owner/coach/student.<gym-id>@example.invalid` identities in the same transaction.
Ordinary install-wide identities remain shared.

## Running the demo

The production runtime connects the boot checks, outbox delivery for login and
signed links, upload restrictions, tenant-free entry routes, and cleanup timer.
Open `https://<DEMO_DOMAIN>/demo` to create a sandbox. Sandbox creation accepts
only the install hostname. Every shell shows demo controls before login guards;
the outbox navigation appears only in a sandbox.

Set `UPLOADS_S3_BUCKET`, optional `UPLOADS_S3_ENDPOINT` and `UPLOADS_S3_REGION`,
and credentials via `UPLOADS_S3_ACCESS_KEY_ID` / `UPLOADS_S3_SECRET_ACCESS_KEY`
(or the provider's normal credential chain). Use a dedicated uploads bucket,
separate from backups. The runtime wraps every uploads adapter with `demoUploads`.

`gym-app seed <gym-uuid>` and `pnpm seed <gym-uuid>` run the registered seed steps.
Demo and gym-deletion HTTP contracts live in `@plaingym/shared/contracts`.

## Composition

Runtime and shared composition use these exports:

- `demoBootCheck(env)` **before** normal auth/email/payment construction.
- `createDemoRuntime({ env, installOrigin, removeUploads })` after DB initialization.
  Use its `authConfig` (outbox counts as configured delivery), `sendMagicLink`, and
  `emailFor(gymId)` for **all** delivery paths, including signed-link email. Do not
  construct SMTP in demo mode. Honor `skipSetup` and wrap every upload provider in
  `demoUploads` before passing it to any feature.
- `/api/demo/sandboxes` on the install origin **before tenant resolution**. The
  other registrations in `demo.routes.ts` require resolved tenant context. Keep
  the install route out of the tenant routes when composing the app.
- `runtime.registerCleanup(queue)` returns `scheduleDue()`. Call it on startup and
  once per minute behind the restore gate. It queues one deduplicated install job
  per five-minute window and scans active, suspended and unfinished sandboxes.
  Normal installs register no demo cron jobs.
- `createUploadPrefixCleaner(store)` accepts an uploads object store; it refuses
  foreign prefixes. Supply the deletion callback appropriate to the install's
  storage provider. Never give this helper the backup destination.
- `DemoNotice` in the shared shell **before login/admin guards**, so an anonymous
  sandbox visitor can choose an identity; `TryDemoButton` on the demo entry page.
  The notice links to `/admin/outbox`; the shell enables its navigation entry
  only after the sandbox status check succeeds.
- `createSeedCommand()` for the CLI registry and a root `pnpm seed <gym-uuid>` script.
  `runSeeds(context)` applies the foundation followed by the registered area seeds.
  Each step owns its short transactions and must support retries.

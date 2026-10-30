<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Demo mode

The demo entry host's root opens `/demo`; the development SPA also supplies its
root landing. Creation announces pending work immediately, prevents duplicate
activation and offers explicit retry feedback. Structured `demo.seed_started`,
`demo.seed_completed` and `demo.seed_completed_all` logs report step and total
durations in milliseconds. Failures retain the step, safe error classification
and elapsed duration; no credentials or signed-link tokens enter these logs.

The demo service creates a separate gym per visitor with a random hostname, seeded
content packs, owner/coach/student identities, and one kiosk device. It never calls
`gyms create` or sends a bootstrap email. The API returns the kiosk token once;
only its SHA-256 hash is stored. Ready sandboxes do not retain bootstrap email.

`DEMO_MODE=true` requires `TENANCY=multi`, `DEMO_DOMAIN` (a lowercase hostname with
wildcard DNS/TLS), and optionally `DEMO_MAX_SANDBOXES` (1–1000, default 50).
`demoBootCheck` rejects live Stripe keys in the environment; `verifyDemoStoredKeys`
also decrypts and checks existing gym Stripe configuration before startup.

Optional billing uses `DEMO_STRIPE_TEST_KEY` (`sk_test_…` or `rk_test_…`) and
`DEMO_STRIPE_WEBHOOK_SECRET` (`whsec_…`) from the install environment. A configured
key requires the signing secret; live keys and other key formats refuse startup.
Without the key, creation succeeds and logs `Demo billing seed skipped` with the
missing variable name. Payments and the Stripe health tile report unconfigured.
With the key, the portal seed leaves billing on, so each sandbox's `/join` takes
test-card payments through the shared account.
Webhook requests pass through to the tenant route, which returns 503
(`Payments are not set up for this gym`) for a sandbox without the shared key.

Configure one Stripe test-account endpoint at
`https://<DEMO_DOMAIN>/webhooks/stripe`, subscribed to the events in
[`webhookEvents`](../infra/payments/setup.ts). Its signing secret is shared by
all sandboxes. Body limits and the restore gate run before this install route;
tenant and session middleware run afterwards. Only active, ready, unexpired
sandboxes are destinations. `gym_id` metadata selects a candidate; the provider
verifies the signature and ownership. Unknown, expired and unrelated events are
acknowledged and discarded when the shared key is configured, including when no
active sandboxes remain. Untagged refunds and disputes resolve their parent
through gym-scoped providers.

For local development, run `stripe listen --forward-to
http://127.0.0.1:3000/webhooks/stripe` in test mode on the same Stripe account as
`DEMO_STRIPE_TEST_KEY`. Set `DEMO_STRIPE_WEBHOOK_SECRET` to this CLI listener's
signing secret, then restart the development server. A Dashboard endpoint secret
is different from a CLI secret. Forward to the API port directly; the demo
install endpoint chooses the sandbox from verified provider ownership.

Distinguish a CLI authentication/reconnection failure from the status of its
local forwarded POST. A local signature failure returns 400 (`webhook_invalid`);
an accepted event returns 200 and is then processed asynchronously in the inbox.
Check both receipt and processing. Restarting a listener does not prove an older
event was replayed. For a missed setup event, the authenticated Checkout return
or restarting that link's card setup can recover the saved card after verifying
the current Stripe objects. Reopening an expired or completed setup creates a
new usable Checkout session. Never print keys, signing secrets, signed-link
tokens or full event payloads when diagnosing this flow.

The install credential is resolved directly for both seeding and normal sandbox
payments; it is never copied into gym rows. This avoids duplicating a shared
secret in every disposable sandbox and keeps key rotation at install scope.
Customers, saved cards, collection and staff payment actions use that same test
account with each sandbox's gym ID. Billing seed effects use the existing runtime
publisher for receipt/dunning and default day-3/7 retry jobs.

The cap uses unique `sandbox-1` through `sandbox-N` slugs, so it holds across app
processes and concurrent requests. Failed or unfinished allocations occupy a slot
until deletion. Their temporary reservation marker lets expiry recover a crash
between audited gym reservation and seeding. Creation is limited to three requests
per client address per hour, per process; login to 20 per minute per gym/address.
The login's internal magic-link sign-in uses the same 20-per-minute rule instead of
the ordinary sign-in limit of five.
Untrusted forwarded headers do not change the bucket. Use the trusted-proxy options
when Caddy is the sole peer. Configure the same cap on every app process.

Provisioning failures roll back using the gym's current revision, since seed steps
can change it. If upload deletion fails, the gym stays suspended for expiry to retry.
The original provisioning error is preserved even if rollback also fails. Structured
`demo.seed_failed` logs identify the gym and seed step; `demo.provisioning_failed`
and `demo.cleanup_failed` distinguish the original failure from rollback failures.
Error details use the server's sanitized logger. Unexpected HTTP failures return a
generic 500 with the request ID, also recorded by `http.unhandled`.

`OutboxEmail` implements `Email` with no SMTP dependency. It records text and HTML,
never delivers to an external mailbox, and rejects calls inside transactions.
The outbox is owner/admin-only, uses cursor pagination, and scopes detail IDs to
the current gym. Its HTML preview disallows scripts and network requests.

Identities use the existing account provisioner and auth service. Demo login captures
and consumes a request-local magic link without an email transport, then returns the
normal signed, secure, host-only auth cookie. It never implements another session
format. Student data is linked to a household; staff roles stay in `staff_roles`.

Only demo mode configures gym deletion; on every other install `DELETE /api/settings/gym`
returns 404. Gym deletion checks revision and suspends the gym before cleaning uploads outside a
transaction. A storage error leaves a suspended gym that an install cleanup job can
retry. A single gym deletion cascades all rows carrying its `gym_id`, including jobs,
sessions and audits. Deleting a sandbox also removes its three deterministic
`owner/coach/student.<gym-id>@example.invalid` identities in the same transaction.
Ordinary install-wide identities remain shared.

## Running the demo

The [demo installer](../../../../deploy/demo/README.md) sets up the server, wildcard
TLS, and S3 configuration. Open its printed link to create a sandbox. A new sandbox
opens on its start page (`/demo`), which offers one-click owner, coach and student
logins, the public join with the test card, and the kiosk; the demo controls link
back to it. No command line setup is needed in a sandbox.

The [mat seed guide](seed/mat.md) describes the sample households, schedule and
promotion history; the [portal seed guide](seed/portal.md) describes the student's
portal and the full demo walkthrough. Seeded households use kiosk PIN **2468**. Search by a **full
member name**, for example **Marcus Rivera**, then enter that PIN. A broad search
such as "family" or "Ma" can match several households; the kiosk refuses ambiguous
matches. Staff can find other sample members' full names in the members page.

The production runtime connects the boot checks, outbox delivery for login and
signed links, upload restrictions, tenant-free entry routes, and cleanup timer.
Open `https://<DEMO_DOMAIN>/demo` to create a sandbox. Sandbox creation accepts
only the install hostname. Every shell shows demo controls before login guards;
the outbox navigation appears only in a sandbox.

Set `UPLOADS_S3_BUCKET`, optional `UPLOADS_S3_ENDPOINT` and `UPLOADS_S3_REGION`,
and credentials via `UPLOADS_S3_ACCESS_KEY_ID` / `UPLOADS_S3_SECRET_ACCESS_KEY`
(or the provider's normal credential chain). Use a dedicated uploads bucket,
separate from backups. The runtime wraps every uploads adapter with `demoUploads`.

Waiver signing accepts only validated PNG signatures through its dedicated,
member-authorized path. Each sandbox has 64 audited signature-image admissions,
reserved before storage under a database row lock, shared by all members and app
processes. Failed writes retain their admission. The 256 KiB / 1200×600 PNG checks
bound each image; generic photo/file uploads remain disabled. Signatures use the
normal immutable snapshot, digest, PDF and erasure behavior. Onboarding completes
after both the saved card and every current household waiver are confirmed.

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
  `runSeeds(context)` applies foundation, members, billing, waivers, mat and portal seeds.
  Both sandbox creation and the seed CLI use this composition. Billing receives
  the same scope and clock as the other seeds and a shared test-account provider.
  Each step owns its short transactions and must support retries.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Security model

Two rules come first, and both are treated as zero-tolerance bugs:

1. **A gym never sees another gym's data.**
2. **A member never sees another household's data.**

This page explains how the code enforces them, who may do what, and how
credentials and secrets are handled. To report a vulnerability, see
[`SECURITY.md`](../SECURITY.md).

## Gym isolation

Isolation is enforced in the database, not only in application code.

* **Row-level security.** Every table has row-level security enabled *and
  forced*. Gym-owned tables carry `gym_id` and a policy that compares it with the
  transaction's `app.gym_id` setting, for both reads (`USING`) and writes
  (`WITH CHECK`). With no gym set, a query sees nothing.
* **`forGym(gymId, fn)`** (`packages/db`) is the only way app code reaches gym
  data: it opens one short transaction with `app.gym_id` set. Importing the raw
  database client elsewhere, raw SQL, and table names as text are rejected by
  lint outside a few reviewed infrastructure files.
* **System tables** (`gyms`, `gym_domains`, `jobs`, the auth tables, `backup_runs`,
  `stripe_events` and a few more) are listed in an inventory with each table's
  access kind and the modules allowed to use system context. Inside `forGym` a
  gym sees only its own system rows; system context (`forSystem`) is lint-limited
  to tenancy, auth, job claiming, the webhook inbox, setup and restore, and still
  grants no gym-owned data.
* **Database roles.** The app connects as `app`: DML only, no DDL, no
  `BYPASSRLS`, never a superuser. The `maintenance` role (`BYPASSRLS`) runs only
  migrations, backups and restore. In multi-gym mode the running app never holds
  the maintenance credentials and refuses to start if they are set.
* **Composite foreign keys.** References between gym-owned tables include
  `gym_id`, so a row can't point at another gym's row even through a bug.
* **Checked on every start.** After migrations, a catalog check compares every
  table's policies, `ENABLE`/`FORCE` flags, privileges, ownership and tenant keys
  with what the schema declares, and startup fails on any difference. A table the
  running version doesn't declare (a newer release's, after a rollback) passes only
  with exactly the gym policy or a system access kind's policies, forced, for the
  `app` role alone, and no more than ordinary table privileges. CI runs the same check.
* **Tests.** Every gym-owned route has a cross-gym test (gym A's session on gym
  B's resource is a 404).

In multi-gym mode the gym comes from the request's `Host` header, matched against
`gym_domains`; forwarded host headers are never trusted. Sessions, magic-link
tokens and OAuth state record the gym that issued them and are refused on any
other gym. Uploads are stored under a per-gym key prefix.

Details: `packages/db/README.md` ("Startup and security", "Scoped access").

## Household isolation

Members reach the app through the portal, signed links, the kiosk and the public
pages.

* **`forHousehold`.** Portal and signed-link code may not import `forGym` or the
  database client (lint-enforced). It reads through `forHousehold`, which checks
  the login's link to the household inside the gym transaction and offers only
  named queries, no raw handle.
* **Payer and member.** Within a household, the payer sees the household's
  members, invoices and payment methods; an adult member who isn't the payer sees
  only their own records.
  `GET /api/portal/credits` requires `profile.read` and returns usable class
  balances and soonest expiries for that same member scope, without ledger rows
  or payment details. Signed links have no credit grant.
* **Portal writes.** The page sends its expected household in `X-Portal-Household`.
  Member authorization rejects a missing or mismatched household with 409 before
  any handler runs, including Checkout and booking changes. The header never
  supplies authority: the gym session and current household link still do.
* **Signed links** grant exactly one purpose for one resource: pay one invoice,
  update the household's card, sign one member's waivers, onboarding, or change
  one member's announcement subscription. The
  token is 256 random bits; only its SHA-256 digest is stored. Each request
  reloads the link and refuses it once revoked, used or expired. A link can't
  read bookings, attendance, ranks, memberships or emergency contacts.
  Announcement unsubscribe links last 90 days and remain reusable until expiry.
  Their GET page never changes preferences; a button or a cookie-less one-click
  POST opts out only the stored member, and the page can subscribe that member
  again. The separate `announcement_opt_outs` row leaves `members.email_opt_out`
  untouched. This link grants no household, billing or waiver access and is
  excluded from staff link lists, resends and revocation. Preference writes lock
  and recheck the link and member, with their audit in the same transaction.
  The one-click POST has a separate 10,000/minute per gym/client budget and is
  exempt from the general flood limit. Junk from other client addresses cannot
  spend a provider's budget. The page button/API keeps 30/minute per gym/client
  and the app's general flood protection.
* **Kiosk.** A kiosk authenticates with a revocable device token (256 random bits,
  stored as a SHA-256 hash, checked on every request) that reaches only the
  check-in endpoints, never a staff session. Settings shows the token once, as a
  setup link (`/kiosk#token=…`) and QR code; the token sits in the URL fragment,
  which the browser never sends to the server, and the page stores it and removes
  it from the address, including when a setup link is pasted into an already-open
  kiosk tab. Replacing the token clears the current check-in screen.
  Name-and-PIN check-in is limited to
  10 wrong PINs per minute per device and per client address, and a used-up
  budget is audited and shown on the dashboard.
* **QR check-in codes** are per member, revocable, valid only in their own gym,
  and derived with the gym's own random key; only their hash is stored.
* **Tests.** Every member-facing route has a cross-household test (household A's
  login, link, PIN or QR code on household B's resource is a 403 or 404).

## Roles and capabilities

Every route declares the permission it needs when it is registered; a route
without one can't be mounted, and unauthenticated access is an explicit `public`
permission. A permission is one of:

* a **staff capability**, granted to staff roles (below);
* a **member capability**, granted to the payer or member scope of a portal login;
* **kiosk check-in**, for a registered kiosk device;
* a **signed-link purpose**;
* **public**.

Navigation hides what a user can't use, but hiding is never the check: the route's
permission is. The maps live in `packages/shared/src/permissions.ts`, and a test
keeps these tables in step with it.

### Staff capabilities

| Capability | Owner | Admin | Coach | Front desk |
| :--- | :---: | :---: | :---: | :---: |
| `integrations.manage` | yes | | | |
| `ownership.transfer` | yes | | | |
| `settings.manage` | yes | yes | | |
| `plans.manage` | yes | yes | | |
| `taxes.manage` | yes | yes | | |
| `staff.manage` | yes | yes | | |
| `go_live.manage` | yes | yes | | |
| `refunds.create` | yes | yes | | |
| `data.export` | yes | yes | | |
| `members.anonymize` | yes | yes | | |
| `members.read` | yes | yes | yes | yes |
| `members.manage` | yes | yes | | yes |
| `households.manage` | yes | yes | | yes |
| `tags.manage` | yes | yes | | yes |
| `links.send` | yes | yes | | yes |
| `announcements.send` | yes | yes | | |
| `leads.manage` | yes | yes | | yes |
| `reports.read` | yes | yes | yes | |
| `reports.revenue` | yes | yes | | |
| `payments.record` | yes | yes | | yes |
| `payments.custom` | yes | yes | | |
| `billing.read` | yes | yes | | yes |
| `medical.read` | yes | yes | yes | |
| `emergency_contacts.read` | yes | yes | yes | yes |
| `attendance.manage` | yes | yes | yes | yes |
| `class_notes.manage` | yes | yes | yes | yes |
| `bookings.manage` | yes | yes | yes | yes |
| `portal_access.manage` | yes | yes | | yes |
| `schedule.manage` | yes | yes | yes | |
| `promotions.manage` | yes | yes | yes | |
| `kiosk_devices.manage` | yes | yes | | |

`leads.manage` grants owners, admins and front desk access to lead details and
contact history. Coaches cannot access leads or contact notes. Lead rows and
contacts have forced gym RLS and composite references; intake records its source
and a source-only audit in the same transaction. Leads are never automatically
deleted or erased. Join intake records leads on submission, so unsubmitted
admissions can still be removed by admission cleanup. A check-in or a membership
activation advances a lead's stage in its own transaction (a prospect or trial
member without a lead gains one with no source); its `lead.stage_changed` audit
holds only the stage and revision. `GET /api/leads/funnel` returns only counts
per source, never member details, with `Cache-Control: no-store`.
The staff list, read, edit, lost and reopen routes also require `leads.manage`
and disable caching. They exclude erased members; first edits of row-less
prospects and trial members use revision 0, and all edits compare revisions.
Won stages come only from membership activation. Lost leads remain stored,
hidden by the default list filter, and can be reopened to `contacted`.
Lost reasons are never copied into audits.
The contact log routes (`GET` and `POST /api/leads/{memberId}/contacts`) require
`leads.manage` and disable caching too. A logged contact records the signed-in
staff user; its `lead.contacted` audit holds the channel, stage, follow-up and
revision, never the note. An erased member's contacts are deleted and their
routes return 404. The dashboard's "Follow-ups due" tile also needs
`leads.manage`, so a coach's dashboard runs none of its reads.

`reports.read` allows owners, admins and coaches to read `GET /api/reports/attendance`.
`GET /api/reports/members` additionally requires `billing.read`, so only owners
and admins, or staff assigned both coach and front desk roles, can read member activity and churn.
Front desk staff alone and member sessions cannot read reports. Reports read only the
resolved gym's rows through `forGym` and forced RLS, including program names;
responses carry `Cache-Control: no-store`. `GET /api/reports/revenue`
requires `reports.revenue` (owners and admins) before validation. Combining
coach and front desk roles cannot grant revenue access. Its
payments, refunds, invoice lines, payment audit markers and current catalog names
are read in one `forGym` transaction, with no billing writes.

`integrations.manage` covers Stripe, SMTP and backups: the setup wizard, and
**Settings → Email, payments and backups** after it, whose responses and audits
never contain a password, key, signing secret or storage credential. It also
covers **Settings → Updates**, the switch for automatic patch updates, and
**Settings → Google sign-in** (with the wizard's Google page), whose client
secret is never returned, logged or audited.

On a multi-gym install the email and payments parts are the operator's by default
(`GYM_INTEGRATIONS=operator`): the sections are read-only and their write routes
answer 403 even for an owner. With `GYM_INTEGRATIONS=gym` owners can name their own
SMTP server, so a gym owner's input reaches the server's network. Ports stay limited
to 25, 465, 587 and 2525, and a gym's own server must be on the public internet: the
app resolves the name once, refuses it if any address is private, loopback,
link-local, reserved or IPv4-mapped, and connects to the address it checked, so a
name that changes its answer can't reach a private one. TLS still verifies the name.
This holds for the test message and every real send, under either setting. A
refused host answers like any other failed test, so an owner can't tell it from a
name that doesn't resolve. The install's own `SMTP_*` server is the operator's and
isn't checked; neither is any server on a single-gym install.

`payments.custom` is billing a custom amount; front desk bills catalog charge
types and existing invoices only.

### Member capabilities

| Capability | Payer | Member |
| :--- | :---: | :---: |
| `profile.read` | yes | yes |
| `progress.read` | yes | yes |
| `attendance.read` | yes | yes |
| `checkin.manage` | yes | yes |
| `bookings.self` | yes | yes |
| `household.read` | yes | |
| `bookings.household` | yes | |
| `billing.manage` | yes | |
| `waivers.self` | yes | yes |
| `waivers.household` | yes | |
| `household.manage` | yes | |
| `memberships.manage` | | |

## Sign-in

Authentication uses Better Auth for identities and sessions only; roles live in
PlainGym's own tables. Only an allowlist of its endpoints is reachable (password
sign-in when enabled, magic-link request and verification when email is set up,
Google sign-in and its callback when the gym has a Google client, get-session,
sign-out); every other library endpoint is a 404, and no endpoint
lists or bulk-revokes sessions. There is no public sign-up: identities are created
by setup, the gym CLI, staff and portal invitations, and the join flow.

* **Magic links** are sent when the gym has SMTP (its own or the install's). The
  token names the issuing gym, is stored hashed, expires after five minutes and
  works once.
* **Passwords** are for self-hosted installs without email. `AUTH_PASSWORD_LOGIN`
  is `auto` (on only for a gym with no SMTP), `on` or `off`; multi-gym mode
  requires `off`. Hashes are Argon2id (19 MiB, two passes) with a random salt,
  and a process runs at most two hashes at once.
* **Google** sign-in is on only when the gym has a Google OAuth client: the
  server's configuration (`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`), which
  wins when set, or on a single-gym install the client the owner entered (owners
  only; stored encrypted, its secret write-only: never returned, logged or audited).
  In multi-gym mode the client comes only from the install, never from a gym
  owner, and a stored one is ignored. The client is looked up on each Google
  request, so a change needs no restart. The OAuth state
  records the gym that issued it, and a callback whose state another gym issued,
  or that is unknown or expired, is refused before the code is exchanged, so a
  Google sign-in never crosses gyms. Google signs in existing identities only (no
  sign-up, no sign-in with a bare ID token) and joins an identity by email only when
  both Google's address and the identity's own are verified. The app keeps the
  Google account's ID and none of its tokens.
* **Rate limits.** Two limits, both counted in the database so every app process
  shares them, and both answered with 429 and `Retry-After`:
  * **Per client address:** 20 attempts a minute at each of password sign-in,
    magic-link requests, magic-link verification and Google sign-in. This bounds
    one address trying many accounts, while a class signing in from the gym's Wi-Fi
    or visitors behind a carrier's shared address aren't locked out together.
  * **Per account:** 10 attempts in each fixed ten-minute window at password
    sign-in, and separately at magic-link requests, keyed by the normalized email
    whether or not an account has it. This bounds guessing one account's password
    from many addresses and the sign-in emails one address can be sent. Anyone can
    use up an account's window, which then refuses that account until it ends;
    Google sign-in and an already-sent link still work.
* **Resets.** Staff may reset the password only of users whose roles are all below
  their own (a member who is also staff counts as staff). An owner resets their
  own password with `gym-app auth reset-password <email>` on the server. A reset
  deletes all of the user's sessions.
* **Setup.** The first owner is created, or a backup restored, only with the
  `SETUP_TOKEN` from the server's `.env`, sent from the private link the installer
  prints. A valid certificate for the hostname is not enough.

Details: `apps/server/src/infra/auth/README.md`.

## Requests

* **CSRF.** Cookie-authenticated writes need an `Origin` that matches the gym's
  canonical origin, and cross-site Fetch Metadata is refused. The Stripe webhook
  path is exempt because it verifies Stripe's signature; kiosk calls use a bearer
  token instead of cookies.
* **Rate limit.** 300 requests per minute per gym and client address by default
  (`RATE_LIMIT_PER_MINUTE`), held in process memory as flood protection. On a
  single-gym install it runs before the gym is looked up, keyed per client for the
  whole install (the one gym's budget, whatever `Host` a request carries), so a
  refused request costs no database work; a multi-gym install checks it after
  resolving the gym. The one-click unsubscribe `POST /l/<token>` uses its own
  10,000/minute per gym/client budget instead. Sign-in,
  kiosk PINs and CSP reports have their own limits. Behind Caddy, `TRUST_PROXY=true`
  makes the last `X-Forwarded-For` entry the client address; nothing else trusts
  forwarded headers, except that with `TRUST_CLOUDFLARE=true` (set by the installer
  when the hostname is proxied by Cloudflare) the app takes the client from
  `CF-Connecting-IP` when, and only when, the address Caddy forwarded is in
  Cloudflare's published ranges (pinned in `deploy/cloudflare-ranges.txt` and
  `core/cloudflare-ranges.ts`, kept identical by a test). From any other address the
  header is ignored, so it changes nothing for a server that isn't behind
  Cloudflare. **Limit:** those ranges are shared by every Cloudflare customer, and
  the server also accepts connections that don't come through the proxy, so
  traffic sent from inside Cloudflare's network (for example a Worker opening its
  own connection to the server's address) can choose `CF-Connecting-IP`. That
  defeats per-address limits only: not authentication, and not the per-account
  sign-in limit.
  Public intake routes name stable budgets for the PostgreSQL counter store;
  runtime startup enables it with `registerIntakeRateLimits`. These limits run
  before route body parsing and validation, group IPv6 clients by /64, and use
  fixed windows shared across processes and restarts. The public token routes
  (portal invitation acceptance, portal claim completion and staff invitation
  acceptance) have named budgets too. Once the database refuses a budget, the
  process refuses that client locally until the window ends, without another
  database transaction; another process may still ask the database once. A
  rejected counter write returns the usual 429 with `Retry-After` when a separate
  connectivity probe succeeds, is logged (`rate_limit.intake_store_failed`, at most
  once a minute per process) and is remembered for one second only, so the
  database is asked again soon after it recovers; a database outage
  follows normal request error handling. An hourly sweep removes expired windows
  in batches of at most 5,000 rows. App factories without runtime registration and
  unnamed budgets keep in-memory counting; authentication and kiosk budgets are
  independent.
* **Body limits** per route, applied before parsing. Routes allowing more than
  1 MiB require a valid `Content-Length` for a body and refuse transfer encoding
  before buffering (including join forms, signatures and CSV uploads).
* **Headers.** Every response enforces a Content Security Policy. By default (the
  admin, portal, kiosk, setup wizard and API) scripts, styles, fonts, connections and
  form submissions stay on the app's origin, server-rendered inline scripts need the
  response's nonce, images may also be `data:` URLs or come from the uploads bucket,
  and application pages may not be framed (`frame-ancestors 'none'`, plus `X-Frame-Options: DENY`).
  Validated waiver documents allow same-origin framing, with a sandboxed policy
  and `X-Frame-Options: SAMEORIGIN`; public signing pages allow these same-origin
  frames. An always-visible document link supports browsers without inline PDFs.
  Uploads accept plain web, email and page links and a `GoTo` opening-page action;
  other annotation subtypes, active actions, forms and embedded files are refused.
  Rendering a signed record checks its stored document hash and resource bounds
  without reapplying upload acceptance policy. Document processing allows at most
  two waiting jobs per gym within its eight-job queue; overload returns 429 with
  `Retry-After`. Template reads allow 300 requests per gym/client per minute so
  members sharing an address can read several documents, and refused frames show
  a retry page.
  Public pages, signed links and downloads send stricter policies of their own; the
  public website's pages run no script and allow only their structured-data block,
  by the response's nonce.
  Payment pages are left by navigation, never by a form submission, so Stripe
  Checkout needs no exception in `form-action`. Every policy, the default one and
  each route's own, reports its violations to `/csp-report`, where they are logged
  without IDs, tokens or query strings, within per-client, per-gym and install-wide
  budgets held in memory, so a report costs no database read. In multi mode the
  runtime loads a hostname-to-gym map at start and refreshes it every minute,
  outside report requests: aliases share a gym budget and unknown hostnames share
  the install budget. A domain added or removed takes effect within a minute.
  In production only the gym's default hostname from the resolver gets
  `Strict-Transport-Security` in multi mode; aliases do not. Single mode uses the
  configured HTTPS install origin (one year, no `includeSubDomains`).
* **Validation.** Every route's input is parsed with its shared Zod contract
  before the handler runs.

Details: `apps/server/src/core/app.md`.

Uploaded waiver PDFs are hostile input. Before storage, the PDF module checks
the file envelope, cross-reference tables, compressed-object syntax and page tree,
including single-revision hybrid files, linearized files and bounded predicted
cross-reference streams. The final index must account for every object without
conflicting definitions. Validation rejects encryption, active actions, forms, attachments, hidden layers and
external references. Size, page count, syntax, decompression, queue and concurrency
bounds apply. The parser has no network or evaluation path; document bytes and
text are not logged. Documents use immutable gym-prefixed keys, and signing and
downloads verify their bytes against the snapshot's SHA-256. App-served five-minute
capability URLs bind each read to its gym and document; both local and S3 responses
use `application/pdf`, `nosniff`, sandboxed CSP and `Cache-Control: private, no-store`.
Link issuance reads metadata only; the download checks the complete content hash.
Document reads and capability downloads are rate-limited per client within each
gym, separately from uploads. Bad tokens cannot consume a gym-wide download budget.
Old versions and documents referenced by signatures remain retained after retirement.

## Secrets and personal data

* **Encrypted at rest.** Stripe keys, SMTP passwords, backup destination
  credentials, a gym's own Google OAuth client, OAuth tokens (Google sign-in stores none), the gym's QR key and the backup blob-naming key are
  encrypted in the database with AES-256-GCM under `APP_ENCRYPTION_KEY`
  (`packages/db/src/encrypted-fields.ts`, `apps/server/src/core/secrets.ts`).
  Passwords, PINs, check-in codes and link tokens are hashed, not encrypted.
* **Bound to their row.** Each value is a `v2` envelope whose authenticated data
  is its secret class, its table and column, and the ID of the row holding it
  (the gym for `gyms` columns, the account for sign-in tokens). Someone who can
  write to the database but doesn't have the key can't move one gym's Stripe or
  email settings into another gym's row, or a value into another column: it no
  longer decrypts there. Values stored before `v2` (`v1`, bound only to their
  class) still read for compatibility until a later release refuses them. The
  step after migrations at each start, including the multi-gym one-shot migrate
  service, receives the app key and rewrites every value it can open as `v2`,
  bound to the row it is in then. This rewrite does not reject a saved `v1`
  value put back into the database afterwards. Every save, restore and key
  rotation writes `v2`.
* **Key rotation.** `deploy/rotate-key.sh` replaces `APP_ENCRYPTION_KEY` with the
  app stopped: the `maintenance` role re-encrypts every registered value from the
  old key to the new one, gym by gym in short transactions under the backup lock,
  after checking that each value opens with one of the two keys. It refuses while
  a restore is unfinished. Before reading secrets, maintenance revokes database
  CONNECT from `app` and `PUBLIC`, waits up to 30 seconds for existing app sessions
  to close, and refuses with their remaining count if any persist. It never
  terminates a session or gains signaling privileges. Under the backup lock, it
  verifies that every value opens as `v2` with the new key and checks again for
  app sessions. The rotation helper retains the fence on every return; the host
  restores `app` CONNECT after switching `.env`, or after a definite preflight
  refusal (exit 3) when every attempt changed nothing; `PUBLIC` stays revoked.
  The marker durably records that pages may commit before each attempt. A partial
  failure (exit 2), any other uncertain failure, or a refusal following either
  keeps the app stopped and CONNECT revoked. A failed final check leaves the host's key unchanged;
  run `rotate-key.sh` again to finish with the same two
  keys. Pending
  backup credentials awaiting confirmation are re-encrypted by rotation and
  restore too; ones that open with neither key are left as they are, and
  confirming them asks staff to generate a new backup key. A run that stops partway
  finishes on the next run (`deploy/README.md`, "Rotating the encryption key").
  The new key protects what is stored from then on; credentials a copy of the old
  database holds must be replaced at their provider.
* **Cards.** Cards are entered only on Stripe-hosted pages. PlainGym stores
  Stripe's IDs (`cus_…`, `pm_…`) and the card's brand, last four digits and
  expiry, never a card number. Each gym uses its own Stripe account; the app
  registers its webhook endpoint and verifies every event's signature.
* **Backups** are encrypted with [age](https://age-encryption.org) to a public key
  whose private half the owner keeps; the server can write backups but can't read
  them. Each backup also carries `APP_ENCRYPTION_KEY`, encrypted the same way, so a
  restore on a new server can decrypt the stored secrets.
* **Erasure.** Staff with `members.anonymize` can erase a member's personal data
  on request: contact details, birth date, emergency contacts, medical notes,
  photo, signed waivers and signature images, lead contacts and lost reasons,
  logins and links, the reasons on class credit adjustments, and the commitment
  override reason on their memberships. The lead row
  and the credit ledger rows remain for aggregate counts and the books. Invoices and
  attendance keep their IDs for the books. Erasing a household's last member also
  revokes its cards, clears each card's billing name, email, phone and address at
  Stripe before detaching it, and clears the Stripe Customer's name, email, phone,
  address, shipping details, description, individual and business names and invoice
  custom fields, and deletes its tax IDs. Every retry job of an erasure (each
  revoked card's detach, the release of the erased photo and signature images, and
  the customer redaction) commits in the same transaction as the erasure, so a
  crash or a later failure cannot lose a retry between clearing the local data and
  queuing it; an erasure never runs without the job queue. Provider and storage
  calls run after commit, and waitlist promotion for the freed places runs last.
  Customers erased before this was complete
  are redacted once from the erasure audits
  (`apps/server/src/areas/members/README.md`).
* **Delivery records.** `email_deliveries`, the record that keeps each email from
  being sent twice, holds no plain hash of a member's address once the member is
  erased, so nobody holding the database or a backup, without the install's
  `AUTH_SECRET`, can test a guessed address against it. A member notice (receipts, dunning) is keyed by IDs only. An emailed
  portal invitation's request digest is an HMAC under a key derived from
  `AUTH_SECRET`. Announcements and cancellation notices keep a plain digest of the
  address they went to, so an address gets each message once, and an erasure
  clears the erased member's in its own transaction. Only staff recipients' keys
  carry a hash of their address. An hourly job per gym deletes login-link rows once
  their five-minute link has expired, and rewrites the rows an earlier release
  wrote with a member's address hash (`apps/server/src/infra/email/README.md`).
* **Medical notes** are readable only by owners, admins and coaches, and are never
  returned to signed links or the portal's household view.
* **Audit.** State-changing actions write an `audit_events` row (the app role can
  insert and read audits, never change or delete them), with secrets and
  sensitive fields left out.
* **Logs.** The app logs one JSON line per event with IDs, never error messages,
  request bodies or credentials. Caddy's access log is off unless the owner turns
  it on (`deploy/README.md`, "Access log").

## The server

The app container runs as `node` on a read-only root filesystem, with all Linux
capabilities dropped, `no-new-privileges`, a process limit and no Docker socket.
Only Caddy publishes ports, and PostgreSQL sits on an internal network only the
app can reach. The installer turns on the firewall (SSH, 80 and 443) and
unattended OS security updates. Release images pin every system package and are
scanned for known vulnerabilities each week (`deploy/README.md`).

Automatic patch updates run on the host, as root, from a systemd timer, never in
the app: the app only answers whether they are on and records their results,
through `gym-app auto-update` in its own container. After recording a rolled-back or failed
attempt, the app emails the owners once through the gym's SMTP settings; it still holds no Docker socket. The updater installs only an
image named by a release manifest signed with the project's Ed25519 key
(`release-signing.pem` in the install directory), pulls it by digest and checks
the digest and version it got, and refuses a patch whose migrations differ from
the running image's. It reads only tag names from GitHub's list of releases; the
signed manifest decides what is installed (`deploy/README.md`, "Automatic patch
updates" and "Releases").

## Demo mode

`DEMO_MODE=true` (multi-gym only) lets visitors create sandbox gyms that are
deleted after 24 hours. It sends no email (an in-app outbox instead), disables
visitor uploads apart from bounded waiver signatures, refuses live Stripe keys,
and turns password sign-in off.

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
  with what the schema declares, and startup fails on any difference. CI runs the
  same check.
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
* **Signed links** grant exactly one purpose for one resource: pay one invoice,
  update the household's card, sign one member's waivers, or onboarding. The
  token is 256 random bits; only its SHA-256 digest is stored. Each request
  reloads the link and refuses it once revoked, used or expired. A link can't
  read bookings, attendance, ranks, memberships or emergency contacts.
* **Kiosk.** A kiosk authenticates with a revocable device token (256 random bits,
  stored as a SHA-256 hash, checked on every request) that reaches only the
  check-in endpoints, never a staff session. Name-and-PIN check-in is limited to
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

`integrations.manage` covers Stripe, SMTP and backups: the setup wizard, and
**Settings → Email, payments and backups** after it, whose responses and audits
never contain a password, key, signing secret or storage credential. It also
covers **Settings → Updates**, the switch for automatic patch updates.
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
get-session, sign-out); every other library endpoint is a 404, and no endpoint
lists or bulk-revokes sessions. There is no public sign-up: identities are created
by setup, the gym CLI, staff and portal invitations, and the join flow.

* **Magic links** are sent when the gym has SMTP (its own or the install's). The
  token names the issuing gym, is stored hashed, expires after five minutes and
  works once.
* **Passwords** are for self-hosted installs without email. `AUTH_PASSWORD_LOGIN`
  is `auto` (on only for a gym with no SMTP), `on` or `off`; multi-gym mode
  requires `off`. Hashes are Argon2id (19 MiB, two passes) with a random salt,
  and a process runs at most two hashes at once.
* **Rate limits.** Password and magic-link sign-in allow 5 attempts per minute per
  client address, counted in the database so every app process shares them.
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
  (`RATE_LIMIT_PER_MINUTE`), held in process memory as flood protection. Sign-in,
  kiosk PINs and CSP reports have their own limits. Behind Caddy, `TRUST_PROXY=true`
  makes the last `X-Forwarded-For` entry the client address; nothing else trusts
  forwarded headers.
* **Body limits** per route, applied before parsing.
* **Headers.** Every response enforces a Content Security Policy. By default (the
  admin, portal, kiosk, setup wizard and API) scripts, styles, fonts, connections and
  form submissions stay on the app's origin, server-rendered inline scripts need the
  response's nonce, images may also be `data:` URLs or come from the uploads bucket,
  and no page may be framed (`frame-ancestors 'none'`, plus `X-Frame-Options: DENY`).
  Public pages, signed links and downloads send stricter policies of their own.
  Payment pages are left by navigation, never by a form submission, so Stripe
  Checkout needs no exception in `form-action`. Violations are reported to
  `/csp-report` and logged without IDs, tokens or query strings, within per-gym
  budgets. In production the gym's canonical HTTPS hostname gets
  `Strict-Transport-Security` (one year, no `includeSubDomains`).
* **Validation.** Every route's input is parsed with its shared Zod contract
  before the handler runs.

Details: `apps/server/src/core/app.md`.

## Secrets and personal data

* **Encrypted at rest.** Stripe keys, SMTP passwords, backup destination
  credentials, OAuth tokens, the gym's QR key and the backup blob-naming key are
  encrypted in the database with AES-256-GCM under `APP_ENCRYPTION_KEY`
  (`packages/db/src/encrypted-fields.ts`). Passwords, PINs, check-in codes and
  link tokens are hashed, not encrypted.
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
  photo, signed waivers and signature images, logins and links. Invoices and
  attendance keep their IDs for the books. Erasing a household's last member also
  revokes its cards, clears each card's billing name, email, phone and address at
  Stripe before detaching it, and clears the Stripe Customer's name, email, phone,
  address, shipping details, description, individual and business names and invoice
  custom fields, and deletes its tax IDs. Customers erased before this was complete
  are redacted once from the erasure audits
  (`apps/server/src/areas/members/README.md`).
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
through `gym-app auto-update` in its own container. The updater installs only an
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

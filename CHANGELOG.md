<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Changelog

Notable changes are recorded here using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-11-27

### Added

- A **Sign waivers** campaign: the New campaign screen lists the active, trial, visitor
  and frozen members missing a signature on a current waiver and sends each one a
  signing link.
- An onboarding link offers **Keep this card** when the household already has a usable
  card or bank account on file in Stripe, so a member moving from another system
  doesn't have to enter it again.
- Staff who manage households see a kiosk PIN lock on the member profile's household
  panel and can clear it.
- A prospect who holds a usable class pack credit can book in the member portal and
  check in at the kiosk. Their status doesn't change.
- Updates move PostgreSQL and Caddy to the images a release pins. The updater pulls and
  checks both before anything stops, recreates PostgreSQL after the pre-upgrade
  snapshot and Caddy once the new app is healthy, and puts both back if the update
  fails. The images an install runs are recorded in `.env`.

### Changed

- Portal bookings and waitlist entries need an active, trial or visitor member, the
  statuses the kiosk checks in. Other members are asked to contact the front desk.
  Staff bookings are unchanged.
- Attendance can't be recorded more than five minutes in the future.
- Changing a household's family discount needs plan management. Front desk can still
  change the billing day.
- The kiosk's standing check shows past-due and no-credit reasons only to staff with
  billing access; others are told to see the front desk.
- While the browser holds a staff or member session, the kiosk shows a notice with
  Sign out instead of setup and check-in.
- On a multi-gym install, the Health page no longer shows disk figures, since the
  volumes are shared by every gym.

### Fixed

- Freezing an annual membership no longer skips a year. The billing date stays put
  while frozen, and resuming moves it later by the days frozen. Monthly memberships
  are unchanged.
- A staff void now releases a card attempt waiting for authentication and a stored
  Checkout session first, instead of refusing the invoice.
- When Stripe's expired-Checkout webhook clears an invoice's session first, a void,
  cash payment, charge run or pay link now carries on instead of reporting that the
  invoice changed.
- A charge whose saved payment method Stripe no longer has fails once and starts
  dunning, instead of failing silently every day for a week.
- A background job's lease renewal is retried promptly after a failure and never holds
  up the job's completion, so one slow renewal can't run a job twice.
- Setup's backup step keeps a backup blob key the gym already has, so pruning existing
  snapshots keeps working.
- A refund that comes back failed, canceled or pending shows a message on the invoice.
- A page restored with the browser's Back button is loaded again, so it can't show the
  previous account's screen after a sign-out.
- An owner's `compose.override.yaml` stays loaded while the updater's schema guard is
  in place.
- A manual update checks that a release tag names the pulled image's own version, a
  rewrite of `.env` can't be cut short by a full disk, and a re-run of the installer
  waits for a running update.
- The trial, drop-in and join forms bound the address fields and refuse line breaks in
  names.

### Security

- Inviting staff, or granting a role, on a login whose password nobody proved removes
  that password and ends its sessions, so it can't later sign in as staff. In password
  mode, a staff invitation to an existing login that has a password is refused.
- Password checks when accepting an invitation or claiming an onboarding link count
  against the sign-in limit.
- A gym sends at most 100 login links an hour to addresses that aren't linked to it,
  and a dropped request answers like a sent one. Wrong setup tokens count against the
  install limiter.
- Opening another login's sign-in link while signed in asks for confirmation before
  switching accounts.
- Changing a sign-in email first proves the login, with its current password or a link
  sent to the current address.
- Name-and-PIN check-in locks a household's PIN for 15 minutes after five wrong
  guesses in a row. The count starts again after 15 minutes without a wrong PIN.
- A campaign links only the Stripe customer whose metadata names the household.
- The sign-in account limit stores a keyed digest of the address instead of a plain
  hash. Open limit windows start again once at the upgrade.
- The sign-in library's log lines go through the application log with email
  addresses removed.
- The app image's `libpam` packages are updated (CVE-2025-6020), and PostgreSQL and
  Caddy are pinned at 18.7 and 2.11.9.

### Upgrade notes

- Migrations: yes; take a pre-upgrade snapshot. Migrations 0045 and 0046 add the kiosk
  PIN lock columns to households. `./update.sh` takes the snapshot itself.
- Rollback floor: 1.0.0.
- Manual steps: none. The update installs the new deploy/update.sh and deploy/lib.sh
  itself. deploy/compose.yaml changes only its PostgreSQL and Caddy pins, which updates
  apply through `infrastructure-images.yaml` without editing `compose.yaml`. The update
  to 1.1.0 still runs the 1.0 updater, so those two images move at the next update
  after it. deploy/install.sh changes only new installs and installer re-runs.

## [1.0.1] - 2026-11-27

### Fixed

- The one-command installer now waits, for up to 10 minutes, while a new server is
  still installing its own first-boot updates, instead of stopping at once with apt's
  "Could not get lock" error. If apt still fails, it says to run the same command again.
- A payer who comes back from Stripe Checkout after paying a pay link now sees "You're
  all set" with the payment confirmed and a link to the member portal. Before, the
  payment's webhook usually completed the link first, and the page said only "Already
  done".
- When a restored gym's payments still need checking in the current Stripe mode,
  turning billing on in Go live now says to choose "Check restored payments again",
  instead of "These settings changed elsewhere".
- The README, versioning guide and deployment notes name 1.0.0 as the first stable
  release.

### Upgrade notes

- Migrations: none.
- Rollback floor: 1.0.0.
- Manual steps: none.

## [1.0.0] - 2026-11-26

The first stable release of PlainGym. One install runs a gym's staff admin, members and
households, classes and booking, attendance, ranks and promotions, a check-in kiosk, an
installable member portal, billing through the gym's own Stripe account, waivers and an
optional public website. Install it on a new server with the one-command installer
(docs/install.md). From 1.0.0, patch releases (1.0.Z) carry fixes only and no database
changes, and installs apply them each night with automatic rollback (docs/versioning.md).

### Added

- A server-rendered product page on the demo entry host, with direct showcase and
  GitHub links. Old entry-host `/demo` links redirect to the product page.
  It shows what card payments and text messages cost and how member data is protected.

### Changed

- Over HTTPS (production), every cookie the app sets carries the `__Host-` prefix, so a
  page on another hostname under the same parent domain can't set a cookie this gym's
  site then receives: sign-in cookies are `__Host-better-auth.*` (were
  `__Secure-better-auth.*`), the signed-link Checkout receipt is
  `__Host-plaingym_link_checkout` and the pending join `__Host-plaingym_join`, which
  moves from `Path=/join` to `Path=/`. 0.11.0 is the first release with these names.
  Single-gym installs read the old names only in the 0.11 prereleases; 1.0.0 stops
  reading them, so sessions, pending checkouts and pending joins started on a release
  before 0.11.0 end once (those members sign in again). Multi-gym installs read only
  the new names, as before. Development over plain HTTP keeps the unprefixed names.

### Fixed

- A Compose install's Source code link now follows the running release's tag instead of
  the repository root. An existing install gets it without changing its `compose.yaml` or
  `.env`, because a `SOURCE_URL` that is only the repository root now counts as unset.
  Any other `SOURCE_URL` is still used.
- Private demo start pages show their current deletion time and how activity extends it;
  the product page and read-only showcase show no deletion notice.

### Upgrade notes

- Migrations: initial schema (fresh installation).
- Rollback floor: 1.0.0.
- Manual steps: none.

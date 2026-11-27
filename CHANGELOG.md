<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Changelog

Notable changes are recorded here using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

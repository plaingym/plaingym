<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Changelog

Notable changes are recorded here using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

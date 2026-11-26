<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Changelog

Notable changes are recorded here using [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A server-rendered product page on the demo entry host, with direct showcase and
  GitHub links. Old entry-host `/demo` links redirect to the product page.
  It shows what card payments and text messages cost and how member data is protected.

### Fixed

- A Compose install's Source code link now follows the running release's tag instead of
  the repository root. Updates keep an install's own Compose files, so an existing install
  gets it once its `compose.yaml` has the release's `SOURCE_URL: ${SOURCE_URL:-}` line; a
  manual install whose `.env` was copied from an earlier `.env.example` also clears its
  `SOURCE_URL=` value.
- Private demo start pages show their current deletion time and how activity extends it;
  the product page and read-only showcase show no deletion notice.

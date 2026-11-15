<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Historical database upgrades

Run from a full clone using the pinned Node version, Docker Compose and Chromium:

```sh
pnpm install --frozen-lockfile
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install chromium
node --test e2e/upgrade/*.test.mjs
node scripts/release/build-image.mjs plaingym:upgrade-check
node e2e/upgrade/run.mjs plaingym:upgrade-check
docker image rm plaingym:upgrade-check
```

The Upgrade workflow runs on release tags, manually, and when this suite, database
code, the migrate command (`apps/server/src/cli/restore*`), container scripts, the
Dockerfile, Postgres role setup, production Compose configuration, secret reader, or
health providers change. Results, dump sizes, per-table counts and SHA-256 checksums,
timings, and phone/desktop screenshots are in `e2e/coverage/upgrade/`.

| Internal gate | Commit | Migrations |
| --- | --- | ---: |
| G3 / v0.1 | `f7e2b17e830497d5083d41dc40f2e4097e6cbf24` | 2 |
| G4 / v0.2 | `f197d5a421aab522aad7299ba632b9fee037ba4b` | 4 |
| G5 / v0.3 | `d9b4445d525a1efa9e7673afa13c9dff51f40bda` | 9 |
| G6 / v0.4 | `e13f8cee4cd33f6b2b36489f7ca48325628f8604` | 16 |

These milestones had no release tags. G3 is the foundation integration's final
commit, G4 includes the install QA at the members-and-mat gate, G5 includes the
billing demo's final waiver-upload fix, and G6 is the full-demo gate's checked commit.

Each run reads the migrations and Drizzle schema metadata from these exact commits,
checks that their SQL and journal entries remain unchanged, and inserts a connected
dataset covering every historical table with constraints enabled. It generates a
custom-format dump below 3 MiB; no binary dump or credentials are committed or kept
in artifacts. Every gate's source Postgres and volume are removed before restoring
into a fresh cluster. Current production migrations, catalog checks and RLS setup
run twice. Original columns and row counts must survive unchanged, including
members, households, invoices, payments, signatures and audit events. The one
intentional change is the migration command's `v1` to `v2` secret rewrite: the QR,
SMTP and Stripe configurations' ciphertext is excluded from row checksums, and the production secret reader
must prove identical plaintext and the expected envelope version before and after
migration at every gate. SMTP and Stripe contain valid configuration objects with
random test credentials; the SMTP hostname is deliberately unreachable. Its health
tile reads configuration and test history without contacting the host, and must be
healthy. An existing `v2` envelope must remain byte-for-byte unchanged. A second
migration must preserve every envelope too. The report names each verified column
and checksum exclusion without retaining plaintext or ciphertext. The current image
then starts and an owner reads the dashboard, member, invoice, waiver signature and
health pages at 360 and 1280 px; `/healthz` must be green. Health tiles must be present
and none may report `error`; there is no fixed tile count. Optional, unconfigured
integrations can report their normal health-page setup notices.

The expand check reviews every migration since G3. Drops, renames, truncation,
deletion, and column type changes fail; constraint and index replacement and
additive backfills are allowed, including `ON CONFLICT DO NOTHING/UPDATE` and
triggers with `EXECUTE FUNCTION/PROCEDURE`. Procedural `DO` blocks and dynamic
`EXECUTE` remain rejected. Reviewed contract steps are listed by exact migration
tag in `contractExceptions` in `history.mjs`, with the full SQL file's SHA-256 and
a review reason explaining the compatibility window. The list starts empty:
no migration in this chain needs an exception. A changed file hash fails closed;
an exception for one tag cannot authorize another migration.
The runner appends a column-dropping migration to a temporary copy and proves the
same check rejects it. This guard supplements the real data checks; it does not
prove old application code accepts every new value or constraint. The release
workflow's previous-minor image smoke test covers that separate promise. Before the
first published release, that smoke test reports that there is no previous image.

Every gate gets a unique Compose project, ports 80 and 443 on `E2E_LOOPBACK` (default
`127.0.0.1`), and bounded commands and cleanup. Keep an assigned loopback address;
use a different loopback address for concurrent runs. Port 443 keeps the browser's
Origin equal to the production single-gym origin.
The visitor request budget is raised to the End-to-end stack's value for repeated
page walks; every page API request must still succeed.
Chromium can invalidate connections when Docker creates a bridge. Explicit fixture
GETs (including the initial `/healthz` navigation), sign-in and page loads share
one helper and retry `ERR_NETWORK_CHANGED` at most twice. It checks both rejection
text and request events, including events delivered just after a fetch rejects.
Sign-in is the only POST allowed to retry; page reloads are allowed only when
every new failure is an eligible transport error. All page assertions wait up to
15 seconds. Each failed URL and method
must subsequently succeed, and the report records recovered requests.
An HTTP error, timeout, another transport error, or an unrecovered request fails.
The runner removes its containers, volumes and networks on success or failure and
reports anything left. The caller owns the image passed to it; the workflow removes
the image it builds. Never point this harness at an existing installation.

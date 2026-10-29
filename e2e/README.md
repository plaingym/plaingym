<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and mat browser QA

Fresh-host installation, browser backups/restore, memory and password QA live in
[`vm/README.md`](vm/README.md). Use `node e2e/run.mjs --vm PRIVATE_CONFIG_JSON`
from the repository root to select that suite; the default runner below keeps
its isolated members/mat Compose workflow.

Run from the repository root with the pinned Node and pnpm versions, Docker, and
TCP port 443 available on loopback:

```sh
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install --with-deps chromium
pnpm --dir e2e check-types
pnpm --dir e2e test
```

CI runs this suite in the **End-to-end** workflow on every integration branch, nightly,
and on demand, keeping `coverage/` (the report, and traces of failed tests) as an artifact for
seven days. The hosted Ubuntu runner already has Chromium's system libraries, so the workflow
installs only the browser (`playwright install chromium`), skipping the `apt-get` step of
`--with-deps`, which can stall for many minutes on a slow package mirror. On Windows use
`pnpm.cmd` if PowerShell blocks unsigned command shims. Set `E2E_BROWSER_CHANNEL=msedge` to
use an installed Edge instead of bundled Chromium.

The runner archives **committed HEAD** and builds it with `deploy/Dockerfile`.
Commit application fixes before running. `E2E_IMAGE=<tag-or-digest>` reuses an
already-built image; make sure it contains the commit being tested. No developer
`.env`, working-tree files, credentials, dependencies or other worktrees enter
the build context. The production build and entrypoint are unchanged.

Each run starts its own Compose project: two fresh PostgreSQL databases, a
single-gym install, a demo install with S3-compatible storage (VersityGW) for its seeded
files, and Caddy with local TLS. Credentials are
random for each run. Nothing is exposed except `127.0.0.1:443`. Chromium's resolver
maps `*.localhost` to loopback; the API helper connects to loopback while keeping
the hostname, TLS SNI, Origin and cookies. No public DNS or host-file edits are
needed. Browser TLS verification is disabled only for the local Caddy certificate.
The runner removes its containers, volumes and fixture cache after the tests,
including on a test failure.

The `fresh-setup` Playwright project completes the real wizard before the other
projects, checking each owned step at 360, 768, and 1280 px: no sideways scrolling,
44 px targets, reachable primary actions, and axe WCAG A/AA. It also opens the
restore form and exercises the import choice; the payment step uses its existing
skip action. The `members-mat` project depends on it, so test-file order cannot
cause the install fixture to initialize first.

The single-gym fixture reuses the browser's completed setup (or goes through the
setup API when run without dependencies) and accepts printed staff invitations. It uses
real password sessions for owner, admin, coach and front desk, plus a registered
device token. The demo fixture creates two seeded sandboxes through the public
entry point and uses real one-click sessions.

The checks cover:

* A reviewed route inventory and the full staff-role/anonymous/device permission
  sweep, including additional permissions. Each allowed role must reach request
  validation or the handler; denied roles must fail before validation. Mutations
  use invalid payloads or missing IDs so the sweep preserves the fixtures.
* Household sessions denied staff access; foreign resource reads and writes,
  sessions, device tokens and forged family selections denied across two gyms.
* People CSV preview, a dry run with no members written, commit and family links;
  imported mat history contributing to eligibility; schedule creation; persisted
  coach attendance; cookie-free kiosk family check-in and duplicate prevention;
  promotion and history after reload.
* A moved generated session keeping its ID and attendance after the supported
  seed CLI runs materialization again, plus a stale-revision conflict.
* A portrait touch viewport, real fullscreen, kiosk privacy reset, source link,
  and axe WCAG A/AA checks.
* The admin screens at 360 px and 1280 px (`mobile.spec.ts` for the shell, `mobile-screens.spec.ts`
  for the screens): no sideways scrolling, 44 px targets, axe WCAG A/AA on whole pages, finding a member,
  a promotion, moving a generated session (and the refusal when it lands on another occurrence's
  exact start), a coach's roster check-in, and stacked dashboard widgets. Session moves use New York
  and Tokyo gym time with a Honolulu browser, verify stored instants and local display, and reject
  the New York spring daylight-saving gap. A coach's direct Settings URL has an explanatory empty state.
* Local demo owner/coach switching, seeded members, schedule, staff and dashboard,
  disabled uploads, and invitations captured in the outbox.
* Login errors and a successful password sign-in; the demo entry button creating
  a sandbox, compact role switching and the demo guide dialog; and device setup,
  name/PIN search, family selection and check-in at all three widths, with axe
  A/AA throughout (`setup-kiosk-demo.spec.ts`). The visitor-facing kiosk example
  uses the full name Marcus Rivera and PIN 2468, avoiding ambiguous households.
  Outbox preview dialogs are checked too; axe excludes the email iframe, whose
  sandbox deliberately forbids scripts, while the test checks its sandbox and title.

Browser specs and their helpers import only e2e tooling and local test helpers.
The End-to-end workflow installs this package independently of the application.

`authorization-inventory.json` is a reviewed snapshot, not regenerated during
tests. The running OpenAPI document must match it. It includes the locally
declared photo, invitation-page and schedule-options routes. Household-login
management contracts are absent from the running application and are not in
this inventory. The QR check-in contract is also absent until its implementation
exists. Billing dashboard stubs are outside this mat suite.

The core public trial/drop-in pages and assets are included, with logo revisions
as path parameters. Only the four explicitly listed public intake submissions
may answer 429 when the sweep exhausts their shared production budget; validation
still runs after the limiter. The snapshot additions come from the running
application's OpenAPI document.

Every browser and API request reaches the app from Caddy's one address, so the
stack sets `RATE_LIMIT_PER_MINUTE=20000` instead of the default 300; the limiter
itself is covered by unit tests. A full run takes a few minutes. Failed runs
retain screenshots, traces, the HTML report and container logs in `e2e/coverage/`
(ignored by Git and lint). Open the
report with `pnpm --dir e2e exec playwright show-report coverage/report`.

Test dependencies have their own lockfile and do not change the application's
dependency graph or distributed runtime. Playwright 1.64.1 and TypeScript 5.9.3
are Apache-2.0; axe's Playwright integration and axe-core 4.14.0 are MPL-2.0;
Node and Undici type declarations are MIT. Their license texts are in their
installed package directories and are retained in `e2e/THIRD_PARTY_LICENSES`.
When updating the tooling lockfile, update those notices too. No dependency is
bundled into the app image.

The suite runs locally against the production image. CI can invoke the same
commands on a Linux Docker runner and retain `e2e/coverage/` as its artifact.

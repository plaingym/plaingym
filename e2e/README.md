<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and mat browser QA

Fresh-host installation, browser backups/restore, memory and password QA live in
[`vm/README.md`](vm/README.md). Use `node e2e/run.mjs --vm PRIVATE_CONFIG_JSON`
from the repository root to select that suite; the default runner below keeps
its isolated members/mat Compose workflow.

Run from the repository root with the pinned Node and pnpm versions, Docker, and
TCP port 443 available on loopback (`127.0.0.1`, or another loopback address in
`E2E_LOOPBACK`, such as `127.0.0.2` beside a local proxy that holds `127.0.0.1:443`):

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

Each run starts its own Compose project: three fresh PostgreSQL databases, a
single-gym install with local uploads, a demo install and a multi-gym install (each of those two with
S3-compatible storage (VersityGW) for uploads), a mail catcher (Mailpit) for the multi-gym install, a stand-in for the
Stripe API, and Caddy with local TLS. As in a deployed multi-gym install, the demo and multi-gym
apps hold no maintenance credentials: a one-shot `demo-migrate` or `multi-migrate` service migrates
their database first. Credentials are
random for each run. Nothing is exposed except port 443 on the loopback address.

The demo install keeps sandbox billing on with a random test key. Its Stripe calls
reach `stripe/server.mjs`, a small stateful fake of the endpoints the app uses
(customers, cards, payment intents, Checkout, setup intents, refunds), served as
`api.stripe.com` on the Compose network through a second Caddy whose local CA the
demo install trusts (`NODE_EXTRA_CA_CERTS`). Like Stripe, an open payment-mode
Checkout has no PaymentIntent until it is paid. The browser pays on the fake's
hosted page at `https://stripe.localhost` with `4242 4242 4242 4242`; specs then
deliver a signed `checkout.session.completed` to the install's `/webhooks/stripe`
with the run's random webhook secret (`portal.ts`). No Stripe account is needed. Chromium's resolver
maps `*.localhost` to loopback; the API helper connects to loopback while keeping
the hostname, TLS SNI, Origin and cookies. No public DNS or host-file edits are
needed. Browser TLS verification is disabled only for the local Caddy certificate.
The runner removes its containers, volumes and fixture cache after the tests,
including on a test failure.

The `fresh-setup` Playwright project completes the real wizard before the `members-mat`
project, checking each owned step at 360, 768, and 1280 px: no sideways scrolling,
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
* Every portal and signed-link route in the inventory, both ways between two
  households of one sandbox (the student, and a seeded family that claims a portal
  login from its outbox invitation): each route with a path parameter, aimed at the
  other household's members, invoices, waivers and bookings with a valid body, answers
  403/404; every portal read and each of household A's signed links (all four
  purposes) shows nothing of household B; household A's kiosk PIN finds and checks in
  only A's people; its QR code checks in only its own member and stops working once
  replaced (`household-isolation.spec.ts`).
* The sandbox join at 360 px and desktop (`demo-join.spec.ts`): plans, the signed
  form, the hosted test-card payment, activation only from the signed webhook, the
  outbox sign-in link into the portal, then signing in again without the owner: from
  the start page and the demo menu, and through **Open my sign-in link** on `/login`,
  with a used link's message. A join paid at the desk continues: the portal
  installs (manifest, service worker, no installability errors), books a class, waits
  on a full class and is promoted when staff free the place, shows a QR code that the
  kiosk reads from its camera (frames drawn from the portal's own image), and the
  coach's roster shows the check-in.
* The public website in a seeded sandbox (`website.spec.ts`): turned on and customized
  through the API (a photo, text, colors), every page at 360 px and desktop with no
  sideways scrolling, 44 px targets and axe A/AA under its own nonce policy, the
  `LocalBusiness` structured data, the phone menu without script, and a call to action
  reaching `/trial`. Turned off, `/` redirects to `/portal`, the website's pages answer
  404 and `/trial` still loads.
* Names with no break opportunity (56 characters) stay inside a 360 px screen on the admin bookings panel, dashboard
  widgets, autocomplete options, billing catalog, campaigns, the ranks page (whose status badge keeps its word beside the
  name), the member profile and its attendance breakdown, and the portal schedule (`long-names.spec.ts`; the portal
  check runs the full layout check, and uses a household of its own). `responsive.spec.ts` checks the layout helper itself
  on pages it serves: a static ancestor with `transform`, `filter`, `contain`, `content-visibility`,
  `will-change`, `perspective` or the individual transform properties is the containing block of its absolute and fixed
  descendants, paint containment clips like `overflow`, and a clipped `html` can't scroll sideways.
* Local demo owner/coach switching from the demo menu, seeded members, schedule, staff and dashboard,
  disabled uploads, and invitations captured in the outbox.
* Login errors and a successful password sign-in; the demo entry button creating
  a sandbox, the slim demo bar and the demo menu (role switching, navigation, a bottom sheet on a phone and a side panel wider); and device setup,
  the Scan a QR code / Name and PIN choice, name/PIN search, family selection and check-in at all three widths, with axe
  A/AA throughout (`setup-kiosk-demo.spec.ts`). The visitor-facing kiosk example
  uses the full name Marcus Rivera and PIN 2468, avoiding ambiguous households.
  Outbox preview dialogs are checked too; axe excludes the email iframe, whose
  sandbox deliberately forbids scripts, while the test checks its sandbox and title.
* The production sign-in limits (`sign-in-limits.spec.ts`): one address refused with 429 and `Retry-After`
  after 20 password attempts in a minute while another address signs in, and one account refused after 10
  attempts from different addresses while another account is still tried.
* The enforced Content Security Policy, in every spec that takes `test` from `support.ts`:
  the automatic `cspGuard` fixture fails a test whose pages, in the default context (when
  the test uses it) or any context the test opens itself, log a CSP violation to the
  browser console, enforced or report-only. `responsive.spec.ts` (pages it serves itself)
  and the VM spec (`vm.spec.ts`, its own browser on real servers) don't use it. Its failure message drops signed-link tokens, queries and
  fragments. `csp.spec.ts` checks the guard itself (an injected inline script and style
  are blocked and caught, through `cspViolations`), the staff invitation page's nonce
  script, the public pages (trial, drop-in, join), that a pay link, a card link and the
  portal's invoice and card buttons reach the hosted Checkout page by navigation, and
  that the outbox preview shows a signed-link email with its inline styles under the
  preview's own policy.

The `multi-gym` Playwright project (`multi/`) uses the multi-gym install without demo mode: `gym-app gyms create`
makes two gyms, `alpha.multi.localhost` and `beta.multi.localhost`, and each owner signs in by the emailed magic
link, read from Mailpit's API at `https://mail.localhost`. Each gym gets a coach, a rank system and program, a
household with a minor who signed the waiver and a PIN, a class and booking, a kiosk device, a plan, an invoice, a
household portal login, and a Stripe key saved in its own settings (both gyms save the same key for the fake Stripe, whose
records aren't kept apart per key). Every invitation and sign-in link a gym hands out must name its own hostname. The checks cover:

* In each gym (`flows.spec.ts`): the admin, portal and kiosk (name and PIN) show that gym only, a session or device
  token copied to the other hostname is refused, and a visitor joins at 360 px, is paid at the desk and gets a portal login,
  without the other gym ever seeing the prospect.
* A cross-gym sweep (`isolation.spec.ts`) over every non-public route in `authorization-inventory.json`, in both directions:
  gym A's owner session, household login, kiosk device and signed links, aimed at gym B's member, household, session, booking,
  invoice, signature, device, program, rank, staff, portal login and invitation IDs, on gym A's hostname and on gym B's,
  must answer 4xx and never contain anything of gym B. Mutations get valid bodies, and those with no ID in their path
  (bookings, check-ins, promotions, programs, ranks, classes, staff roles and profiles, waiver signatures) name gym B's
  records in the body; a kiosk check-in of gym B's member or QR code answers, as for any unknown member, with the front
  desk. Every ID-free read and public page of a gym is checked for the other gym's IDs and names, controls prove the same
  credentials reach their own records, and both gyms' records are unchanged afterwards. Resources a fresh gym has none of
  (imports, exports, schedule templates and tags) use an ID nothing holds. Routes outside the inventory (such as the staff
  billing and waiver APIs) aren't in this sweep; the password-reset routes are refused anyway, since a multi-gym install
  has no password login.

Browser specs and their helpers import only e2e tooling and local test helpers.
The End-to-end workflow installs this package independently of the application.

`authorization-inventory.json` is a reviewed snapshot, not regenerated during
tests. The running OpenAPI document must match it. It includes every portal route,
the signed-link API (`/api/links/<purpose>`, which answers 401 without the link's
own token) and the signed-link pages under `/l/`. It includes the locally
declared photo, invitation-page and schedule-options routes. Household-login
management contracts are absent from the running application and are not in
this inventory. The QR check-in contract is also absent until its implementation
exists. Billing dashboard stubs are outside this mat suite.

The core public trial/drop-in pages and assets are included, with logo revisions
as path parameters. Only the four explicitly listed public intake submissions
may answer 429 when the sweep exhausts their shared production budget; validation
still runs after the limiter. The snapshot additions come from the running
application's OpenAPI document.

**Specs hold whenever they run.** The app has no test clock, so a spec can't freeze time, and
the suite is meant to pass at any hour on any day (a run just before a local midnight, on a
Sunday evening, or on a daylight saving change). The date helpers in `dates.ts`, re-exported
from `support.ts` with `createClass` and `showWeek`, keep to these rules:

* Never read a day or week from the day the run is on. Take it from the class the spec created
  or read (`showWeek(page, zone, Date.parse(session.startsAt))`): the schedule opens on the
  gym's current week, and its **Week of** field moves to the Monday that starts the week.
* Build a class time with `classStart` (or `createClass`), which keeps the class clear of the
  gym's local midnight, and a form's wall-clock time with `wall(instant, zone)`: the gym's zone
  for the schedule's forms and the browser's zone (`UTC`, set in `playwright.config.ts`) for
  the promotion form. `toISOString()` is UTC, which is neither unless the zone is `UTC`. A class
  that must start within minutes (the join spec checks in to one) can't wait for `classStart`'s
  window, so it may cross a local midnight; it still takes its day and week from its own start.
* The portal schedule lists seven days from today, not a calendar week, so a seeded class can
  be in either of its first two pages; click **Next week** when it isn't on the first
  (`portalClass` in `demo-join.spec.ts`).

`dates.test.ts` runs with the repository's unit tests (`pnpm test:unit`, no stack needed) and
covers Sunday 23:59, Monday 00:00, month ends and both daylight saving changes in UTC and the
zones the specs use.

The specs meet the production limits as separate visitors would, with no test setting for
sign-in. Each API client (`Client` in `support.ts`) sends its own address from
198.18.0.0/15 in `X-Forwarded-For`; the stack's Caddy trusts the test runner as a proxy and
passes that address on as the only entry, and the apps run with `TRUST_PROXY=true`, as behind
the production Caddy. So no spec waits for a limiter's window. The browser's requests carry no
such header and share the runner's one address, so the stack sets `RATE_LIMIT_PER_MINUTE=20000`
instead of the default 300 for page loads; the limiter itself is covered by unit tests. A full
run takes a few minutes. Failed runs
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

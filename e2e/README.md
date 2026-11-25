<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and mat browser QA

The manual [product screenshot capture](ux-pass/PRODUCT.md) reuses the UX pass's
seeded demo install and writes the product page's committed WebP images. It has
its own opt-in command and never runs in CI or changes the regular UX pass.

Fresh-host installation, browser backups/restore, memory and password QA live in
[`vm/README.md`](vm/README.md). Use `node e2e/run.mjs --vm PRIVATE_CONFIG_JSON`
from the repository root to select that suite; the default runner below keeps
its isolated members/mat Compose workflow. The screenshot walk of every surface
for a UX review (`UX_PASS=1`, its own projects, or the workflow's optional `ux_pass` input) is in
[`ux-pass/README.md`](ux-pass/README.md).

Run from the repository root with the pinned Node and pnpm versions, Docker, OpenSSL, and
TCP port 443 available on loopback (`127.0.0.1`, or another loopback address in
`E2E_LOOPBACK`, such as `127.0.0.2` beside a local proxy that holds `127.0.0.1:443`):

```sh
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e exec playwright install --with-deps chromium
pnpm --dir e2e check-types
pnpm --dir e2e test
```

CI runs this suite in the **End-to-end** workflow on every task and integration branch, nightly,
and on demand. `node e2e/ci.mjs shard-lists` places the setup wizard on stack 1, then assigns whole
files from longest to shortest to the stack with the lowest projected duration. It charges single-gym
and multi-gym fixture setup once per stack that runs the corresponding project. New files use a
20-second estimate. The bank debit spec is placed after every other file (`filesPlacedLast` in `ci.mjs`), so adding it doesn't move existing files between shards. When the suite changes materially, refresh `fileDurations` in `ci.mjs` from
`results.json` and use the shard blobs to estimate and deduct shared setup from the files that ran it.
Each stack runs `pnpm --dir e2e test --test-list coverage/shard-N.txt --no-deps`,
with one worker (`fullyParallel: false`). `E2E_SHARD_COUNT` in the workflow is the single count for matrix
generation and inventory selections; local commands read that workflow default when the environment is unset.
The local command above still runs the entire suite on one stack. The suite includes portal recovery fixtures at 360 px and 1280 px that
check notices in the page and editor, preserved drafts, and the shell's availability
during recovery. The hosted Ubuntu runner already has Chromium's system libraries, so the workflow
installs only the browser (`playwright install chromium`), skipping the `apt-get` step of
`--with-deps`, which can stall for many minutes on a slow package mirror. On Windows use
`pnpm.cmd` if PowerShell blocks unsigned command shims. Set `E2E_BROWSER_CHANNEL=msedge` to
use an installed Edge instead of bundled Chromium.

Each shard uploads `e2e-shard-N`, containing its blob report, traces, screenshots,
and `containers.log` (also on success). After all shards finish, including a failed
shard, the report job merges their blobs into one HTML report. Download
`e2e-coverage` for the entire run: `report/` is the merged HTML report,
`results.json` is its machine-readable result, and `shards/e2e-shard-N/` holds
each stack's diagnostics. All artifacts expire after seven days. Test failures
can be retried with **Re-run all jobs**; uploads replace the same
named artifacts so the merged report reflects the new attempt. Collection or
stack-startup failures can leave a shard without a blob; the merge job fails and
still uploads the available diagnostics. Shard 1 checks the single-stack test
inventory against all shard selections, rejecting missing and duplicate
tests, and the report job checks the merged result against that inventory.
Tests must be declared in spec files; a helper-declared test fails selection with its filename.
Merged-report runtime errors are reported with their details separately from collection errors.

On `task/**` pushes, an independent `changed-specs-test` job runs only new or
changed default-suite specs, plus specs transitively importing a changed helper under `e2e/specs` or
`e2e/multi`, against the merge base with `main`, on its own fresh
stack. It does not delay the shards and is skipped when there are no such specs
(deleted files and the opt-in VM/UX specs are excluded). Its separate artifact is
`e2e-changed-specs`. A `ux_pass` dispatch runs one UX stack, including its browser
projects, in its own concurrency group so it and a push run can finish together.
On `main`, a successful **push** run of this workflow on the same commit allows
the suite to be reused; a UX dispatch never qualifies.

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
(customers, payment methods, payment intents, Checkout, setup intents, refunds), served as
`api.stripe.com` on the Compose network through a second Caddy whose local CA the
demo install trusts (`NODE_EXTRA_CA_CERTS`). An open payment-mode Checkout has
no PaymentIntent until the browser submits a payment method. To pay by card on
the fake's hosted page at `https://stripe.localhost`, use `4242 4242 4242 4242`.
Specs then deliver a signed `checkout.session.completed` to the install's `/webhooks/stripe`
with the run's random webhook secret (`portal.ts`). No Stripe account is needed. Chromium's resolver
maps `*.localhost` to loopback; the API helper connects to loopback while keeping
the hostname, TLS SNI, Origin and cookies. No public DNS or host-file edits are
needed. The runner generates a fresh self-signed certificate and key with OpenSSL for each run,
including a Common Name and the stack's hostnames as Subject Alternative Names, so Firefox can
open it too. Caddy mounts them read-only; the API helper trusts only that certificate
(`E2E_CA_FILE`). Browser TLS verification is disabled only for the local certificate.
The separate internal Stripe proxy continues to use its own Caddy CA.
The runner removes its containers, volumes and fixture cache after the tests,
including on a test failure.

The `fresh-setup` Playwright project completes the real wizard before the `members-mat`
project, checking each owned step at 360, 768, and 1280 px: no sideways scrolling,
44 px targets, reachable primary actions, and axe WCAG A/AA. It also opens the
restore form and exercises the import choice; the payment step uses its existing
skip action. The `members-mat` project depends on it, so test-file order cannot
cause the install fixture to initialize first.

Sharded runs disable dependency expansion with `--no-deps`: Playwright 1.64 would
otherwise add the wizard to every shard containing `members-mat` tests. With the
configured project order and one worker, the wizard runs first on shard 1 only;
the other shards' single-gym fixtures complete setup through the API before use.
An automatic worker fixture ensures even browser-only `members-mat` tests start
with a completed install, without requiring an earlier test to request `install`.
The CI inventory check guards that ordering and the wizard's single occurrence.

The single-gym fixture reuses the browser's completed setup (or goes through the
setup API when run without dependencies) and accepts printed staff invitations. It uses
real password sessions for owner, admin, coach and front desk, plus a registered
device token. The demo fixture creates two seeded sandboxes through the public
entry point and uses real one-click sessions.

The checks cover:

* Logo versions after unrelated settings saves and replacement uploads, with
  rendered admin previews and core public pages at 360 px and desktop widths
  (`website-branding.spec.ts`).
* A reviewed inventory of every operation with its class, and the full staff-role/anonymous/device permission
  sweep over all of them, including additional permissions. Each allowed role must reach request
  validation or the handler; denied roles must fail before validation. Mutations
  use invalid payloads or missing IDs so the sweep preserves the fixtures. Routes this
  install has turned off answer as such: demo routes outside demo mode, the website
  module while the gym has it off, and the Stripe webhook before payments are set up.
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
* The admin screens at 360 px and 1280 px (`mobile.spec.ts` for the shell, `mobile-admin-{phone,desktop}.spec.ts` and `mobile-{portal,public,kiosk-keyboard,portal-keyboard}.spec.ts`
  for the screens): no sideways scrolling, 44 px targets, axe WCAG A/AA on whole pages, finding a member,
  a promotion, moving a generated session (and the refusal when it lands on another occurrence's
  exact start), a coach's roster check-in, and stacked dashboard widgets. Session moves use New York
  and Tokyo gym time with a Honolulu browser, verify stored instants and local display, and reject
  the New York spring daylight-saving gap. A coach's direct Settings URL has an explanatory empty state.
  Whole-page checks run with both light and dark OS color preferences. The admin and portal
  follow the device in a fresh browser, where the account menu defaults to System.
  The kiosk, public join, trial and drop-in pages, and signed-link flows also follow the device.
  The public website and uploaded waiver documents stay light. The same spec audits every signed-in portal page, all five
  signed-link purposes and unavailable-link feedback, `/join` (plans and form), `/trial` and
  `/drop-in` at both widths.
  The responsive captures also audit sign-in, invitation claim, setup, staff billing,
  lead details, reporting, announcements, campaigns, health, account and the demo outbox.
  The invoice detail, staff and member waiver signing, and SMS test-text form are
  checked open. Staff and portal SMS consent are covered in `sms-consent.spec.ts`.
  Keyboard-only flows cover kiosk check-in, portal booking/cancellation, invoice Checkout
  and card updates, visible focus, and trapping/restoring focus in a profile dialog.
  The website's six pages also run axe with both color preferences. Screenshots and
  axe results are attached for each audited preference. The capture helper waits for
  loading states marked with `data-loading` and for status text that starts with
  "Loading". In the outbox capture, screenshots mask
  message bodies and axe excludes them. Axe also excludes the script-blocked email
  preview iframe in `responsive.ts` and audits the surrounding dialog.
* Restored-payment notices before and after connecting Stripe at 360 px and 1280 px
  (`restore-payments.spec.ts`), with fixture reports, screenshots and layout checks.
* Every portal and signed-link route in the inventory, both ways between two
  households of one sandbox (the student, and a seeded family that claims a portal
  login from its outbox invitation): each route with a path parameter, aimed at the
  other household's members, invoices, signed waivers and bookings with a valid body, answers
  403/404; every portal read and each of household A's signed links (all four
  purposes) shows nothing of household B; household A's kiosk PIN finds and checks in
  only A's people; its QR code checks in only its own member and stops working once
  replaced (`household-isolation.spec.ts`). Household A's login can't choose household B,
  and naming B in the portal's household header, or B's member in a portal read's query,
  opens nothing of it. Staff requests that name records of both households at once
  (a login, invitation, card, membership, signed link or link campaign) are refused and
  change neither household; the spec finds every staff operation that takes two household
  records in the running document, so one added later fails until it is covered.
  Current waiver templates belong to the gym and can be read by any authorized household;
  `waivers.spec.ts` checks that distinction with uploaded PDF templates and private signed copies.
* Uploaded PDF waivers (`waivers.spec.ts`): staff upload permissions and demo refusal, byte-identical
  original downloads with sandboxed headers, foreign-gym and tampered-token denials, and immutable
  signed records after switching a family back to text. Staff, portal, signed-link, join and drop-in
  signing use the PDF reference; editor and signing previews run at 360 and 1280 px with the visible
  fallback link, required consent, layout/axe checks and the suite's CSP guard. The portal/public
  cases use the non-demo multi-gym fixtures, since the demo refuses template uploads.
  Each portal, signed-link and public-intake reader keeps its own client address across viewport
  checks and signing, so separate scenarios exercise separate production download budgets.
* The sandbox join at 360 px and desktop (`demo-join.spec.ts`): plans, the signed
  form, the hosted test-card payment, activation only from the signed webhook, the
  outbox sign-in link into the portal, then signing in again without the owner: from
  the start page and the demo menu, and through **Open my sign-in link** on `/login`,
  with a used link's message. A join paid at the desk continues: the portal
  installs (manifest, service worker, no installability errors), books a class, waits
  on a full class and is promoted when staff free the place, shows a QR code that the
  kiosk reads from its camera (frames drawn from the portal's own image), and the
  coach's roster shows the check-in. When an IANA timezone is currently between
  23:30 and 23:55, this flow temporarily uses it for the gym, asserts that the class
  starting soon falls on the next local day, and attaches the timezone and time as
  `midnight-window` evidence. The original timezone is restored even on failure;
  runs without a suitable zone record that fact in a test annotation.
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
  failed attempts from different addresses while another account is still tried.
* The enforced Content Security Policy, in every spec that takes `test` from `support.ts`:
  the automatic `cspGuard` fixture fails a test whose pages, in the default context (when
  the test uses it) or any context the test opens itself, log a CSP violation to the
  browser console, enforced or report-only. `responsive.spec.ts` (pages it serves itself)
  doesn't use it. The VM spec (`vm.spec.ts`) watches both of its own browser contexts with the same guard. Its failure message drops signed-link tokens, queries and
  fragments. `csp.spec.ts` checks the guard itself (an injected inline script and style
  are blocked and caught, through `cspViolations`), the staff invitation page's nonce
  script, the public pages (trial, drop-in, join), that a pay link, a card link and the
  portal's invoice and card buttons reach the hosted Checkout page by navigation, and
  that the outbox preview shows a signed-link email with its inline styles under the
  preview's own policy.

The `multi-gym` Playwright project (`multi/`) uses the multi-gym install without demo mode: `gym-app gyms create`
makes two gyms, `alpha.multi.localhost` and `beta.multi.localhost`, and each owner signs in by the emailed magic
link, read from Mailpit's API at `https://mail.localhost`. Every invitation and sign-in link a gym hands out must
name its own hostname. Each gym's fixtures (`multi/support.ts`) hold one record of every kind the staff API
serves: a coach, a rank system, rank and program, a household with a minor who signed the waiver and a PIN with its
QR check-in code, a class (made with `createClass`, so its time is clear of midnight at any hour of the run) and
its booking, a member tag, a kiosk device, a plan, an uploaded PDF waiver template, two invoices (one paid at the desk, with
its payment and a refund), a charge type, a tax rate, a membership, a card saved through hosted Checkout and the
gym's signed webhook, a signed link and a campaign, a schedule template, a class tag, a data export, an import run
(a dry run of an uploaded CSV), pending invitations, and the household's portal login. Each successful write
is saved before the next operation in its build step. Composite steps preserve these checkpoints, so a worker
resuming after a failure reuses the accepted invitation, program, payment, or other record. The harness spec
deliberately interrupts the coach and ranks steps and checks that resuming creates no duplicate coach or program,
then repeats both interruptions against the same saved writes in a second test.
Before each attempt it clears those two composite checkpoints, retaining their individual writes, so retries
and `--repeat-each=2` exercise the same interruptions. JSON writes use a checkpointing `write` helper that
checks the response through `Client.json()` before saving it.

Each gym saves its own restricted Stripe key, issued once in `run.mjs` and shared with the fixtures through
`E2E_STRIPE_GYM_KEYS` and the fake through Compose's `STRIPE_GYM_KEYS`. The fake Stripe keeps one
account per issued key; unissued keys receive 401 with a key-mismatch diagnostic and
cannot create an account through `/test/sign-webhook` (404). Each request passes its account explicitly:
its own objects, idempotency replies and webhook endpoints, so a call made with one gym's key
never reads or changes another's. Endpoints keep the signing secret returned when they were created, and the
specs sign events through the fake's `/test/sign-webhook` (open to the install's secret key only) and post them
to the gym's own hostname (`deliverStripeEvent` in `portal.ts`, shared with demo specs), as Stripe would. The checks cover:

* In each gym (`flows.spec.ts`): the admin, portal and kiosk (name and PIN) show that gym only, and each schedule
  shows that gym's own class (opened with `showWeek`, and **Next week** on the portal when the class falls
  there), so an empty page doesn't pass; a session or device token copied to the other hostname is refused; and a
  visitor joins at 360 px and pays by card on the hosted Checkout page. Returning from Checkout grants nothing;
  the gym's signed `checkout.session.completed` activates the join and its portal login. An event signed with
  the other gym's secret, or sent to the other gym's endpoint, is refused with 400, the other gym never sees
  the prospect, and the payment is in the paying gym's ledger only.
* Stripe accounts (`flows.spec.ts`, last): each key lists its own customers, Checkout sessions, cards and
  payment intents, none appears in the other account, every object the gym tagged carries its own gym ID, and the
  other key gets 404 for each by ID.
* Bank payments (`bank-debit.spec.ts`): Alpha's owner enables **Accept bank payments**
  for a visitor's join. The fake offers **US bank account** alongside the card
  form when Checkout requests that payment method. The spec delivers signed
  Checkout and PaymentIntent events, checks portal access and the invoice while
  the debit is processing, then uses the fake's `/test/settle-bank-checkout` control
  to test success and insufficient funds. The success case also runs at 360 px.
  Teardown turns off the switch. Real Stripe, including bank verification,
  settlement and Canadian mandate emails, is checked by hand.
* A cross-gym sweep (`isolation-{alpha-beta,beta-alpha}-{1,2,3}.spec.ts`, with public record-ID checks in `isolation.spec.ts`) of every non-public operation of the running OpenAPI document, in both
  directions. Operations are enumerated from the running document: a route added to the application is swept
  without widening a list. Only the demo routes, the single-gym setup wizard and the install's own release state
  are left out (`outOfScope` in `multi/probe.ts`, which fails if an exclusion stops matching a route), and every
  route of `authorization-inventory.json` must be swept or left out. Gym A's owner session, household login, kiosk
  device and signed links, aimed at gym B's records of every kind (member, household, class, booking, invoice,
  payment, refund, card, plan, membership, charge type, tax rate, waiver template and signature, link, campaign,
  schedule template, class tag, tag, export, import, staff, portal login and invitation), on gym A's hostname and on
  gym B's, must answer 4xx and never contain anything of gym B. Bodies and queries are built from each
  operation's schema (`multi/probe.ts`), with gym B's IDs wherever a path or property names a record (the sweep
  fails if a path names no fixture record), so a request is refused for the gym boundary and not for its shape: no
  probe on a gym's own hostname may answer 400, 415 or 422.
  Routes with no ID in their path whose body or query names gym B's records are probed on gym A's hostname too; a
  kiosk check-in of gym B's member or QR code answers, as for any unknown member, with the front desk.
  Signed-link document reads name a template in the path and must refuse the other gym's template too;
  a positive control first proves that each gym's signing link reads its own uploaded PDF.
  The sweep creates an adult member login for the self-service document read, since the household's
  payer login has no member identity; that same credential supplies its positive and cross-gym controls.
  For the authenticated website preview probe, the sweep reuses an existing photo or creates one in each
  fixture gym. The photo stays available to the slices in that stack and is removed when `run.mjs` tears
  down the disposable stack (`docker compose down --volumes`).
  Each direction partitions the complete operation list into three disjoint groups by position, one file per group;
  public reads use the same three-way partition. Every file checks that all six files exist and each sweeps its own group. Each file snapshots both gyms across the full route inventory.
  The sweep prepares four staff-issued signed-link purposes and a real announcement-issued unsubscribe token.
  Both unsubscribe operations receive that token on the other gym's hostname, in both directions. Every
  operation must have probe credentials and receive a foreign-host probe. Each slice has a 300-second timeout.
* A second pass aims a caller's own record in the path at gym B's IDs in the body (an own class or schedule
  template given gym B's programs, an own member given gym B's tag, an own household given gym B's member or
  login, a membership or plan given gym B's plan): every one must answer 404, and the controls then send the same
  shape with the caller's own IDs and are accepted. An explicit `ownPathRoutes` list in `multi/isolation-sweep.ts`
  names the expected own-path operations independently of body generation. Each slice must probe exactly its share
  of those routes in each direction; inserting other operations cannot invalidate the guard by shifting slice counts.
  That list is kept by hand: a new route whose body names another record gets an own-path probe, and the
  guard fails until the route is added to `ownPathRoutes`.
* Every ID-free read and public page of a gym is checked for the other gym's IDs and names, with and without a
  filter naming the other gym's records. Controls prove the same credentials read each of their own records
  (every GET with an ID in its path). Only what a fresh gym lacks may answer 404: member and staff photos
  nobody uploaded, the household login's own self-signed waiver PDFs, and the lead record and contact log of
  the fixture's student, who is a member and not a lead. The plan switch preview answers 409, since the gym's
  only plan is the membership's own. The full, unfiltered lists of both gyms (IDs and revisions of the records
  staff edit) are the same afterwards.

Browser specs and their helpers import only e2e tooling and local test helpers.
The End-to-end workflow installs this package independently of the application.

`authorization-inventory.json` is a reviewed snapshot, not regenerated during
tests. It lists every operation of the running OpenAPI document with its class: who may
call it (`public`, `signed_link` with its purpose, `kiosk`, `member` for a portal login, or
`staff` with the capability whose roles the spec's reviewed matrix lists) and any further
permission. The single-gym install's document must match it exactly, and every operation of
the demo install's must be in it with the same class, so a new route fails the check until it
is listed. It includes every portal route,
the signed-link API (`/api/links/<purpose>`, which answers 401 without the link's
own token) and the signed-link pages under `/l/`. It includes the locally
declared photo, invitation-page and schedule-options routes, and the account routes
with the sign-in email change page (public in the registry: the account and change
request answer anonymous callers with 401), the website module's pages and API, and the demo routes,
which every install's document lists and which answer only in demo mode.

The core public trial/drop-in pages and assets are included, with logo hashes
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
* The portal schedule starts each gym-local week on Monday, like the admin calendar.
  A near-future class can fall in the next week, so `showPortalClass` in `support.ts`
  checks the current page and then **Next week**. The demo join's `portalClass` does
  the same for seeded classes.

`dates.test.ts` runs with the repository's unit tests (`pnpm test:unit`, no stack needed) and
covers Sunday 23:59, Monday 00:00, month ends and both daylight saving changes in UTC and the
zones the specs use.

The specs meet the production limits as separate visitors would, with no test setting for
sign-in. Each API client (`Client` in `support.ts`) sends its own address from
198.18.0.0/15 in `X-Forwarded-For`; the stack's Caddy trusts the test runner as a proxy and
passes that address on as the only entry, and the apps run with `TRUST_PROXY=true`, as behind
the production Caddy. The main process has a reserved 4,096-address block; each worker gets
its own block. Allocating past a block, or beyond the 31 worker blocks, throws rather than
reusing an address and its rate-limit buckets. Password attempts also share an account's
10-per-ten-minute failure budget across addresses; successful password sign-ins give back
their reserved account slot. Login-link requests count every request against their own budget.
So no spec waits for a limiter's window. The browser's requests carry no
such header and share the runner's one address, so the stack sets `RATE_LIMIT_PER_MINUTE=20000`
instead of the default 300 for page loads; the limiter itself is covered by unit tests. A full
run takes a few minutes. Runs
retain container logs in `e2e/coverage/`; failed tests also retain screenshots and
traces, alongside the HTML report
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

`settings-sign-in.spec.ts` uses API fixtures with the production web bundle at
360 px and 1280 px. It checks Google refusals clear on credential edits in Settings
and setup, the Email removal rule stays visible, and an operator-managed payment
refusal reloads the integrations and hides the form. It retains layout screenshots.

`setup-stripe-connected.spec.ts` uses API fixtures the same way on the setup
wizard's payments step at 360 px and 1280 px. It checks the confirmation names test
mode and the webhook address, the request carries the typed key, and **Continue to
backups** opens the backups step. It never contacts Stripe and leaves the install
the fresh-setup spec completes untouched. It retains layout screenshots.

`account-email.spec.ts` uses API fixtures the same way on the account page at
360 px and 1280 px. It checks that a pending email change stays visible beside the
local invalid-address message and a refused request, and that a new request's
success notice replaces it. It retains layout screenshots.

`account-password.spec.ts` uses API fixtures the same way on the account page's
password change at 360 px and 1280 px. It checks that the button is at least 44 px
tall, that a wrong current password shows its alert, and that a change shows its
status and empties the fields. It retains layout screenshots.

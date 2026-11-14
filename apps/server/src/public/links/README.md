<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Signed-link pages

Every signed-link page shows the resolved gym's name and its configured logo,
including unavailable, replaced, already-completed, return and cleared states.
The logo uses the same versioned public image route as the core public pages;
its storage key is never put in the HTML. `brandingFor` optionally supplies these
settings to `configureLinkPages` or `createLinkRoutes`; by default the routes read
them through the gym settings service, with no additional runtime wiring.

Campaign reminders with a link rotate their token. An unresolvable token in the public
`campaign_` format renders a static **This link was replaced** page with instructions
to use the newest email. It returns 404, exposes no data or actions, and looks the
same for made-up tokens and tokens presented to another gym. The prefix does not
grant access; every active token still needs its current, gym-scoped stored hash.
Unmarked unavailable links also mention replacement in their general guidance.
No old tokens or token hashes are retained.

Card payment uses `cardChargeIssue` from `@plaingym/shared/money`, the same minimum
and currency-step check as the saved-card runner. An invoice below the minimum or
off the step shows manual-payment instructions and no Checkout action. The server
checks again before reserving Checkout or contacting the payment provider. Pay-link
emails also give manual-payment instructions without a card link for these amounts.
An open zero invoice shows only a note that no payment is needed, with no
payment action or manual-payment instructions.

`/l/<token>` renders invoice payment, card update, member waiver signing,
household onboarding, or one member's announcement preferences without a login.
Announcement links show only the gym name, member name and subscription state.
GET never changes that preference. The button posts `{ optedOut: true }` (or
`false` to subscribe again) to `/api/links/unsubscribe` with the existing bearer
credential. Neither request can choose a different member or household.

For mail clients, a cookie-less `POST /l/<token>` accepts only the RFC 8058 body:
exactly `List-Unsubscribe=One-Click` as `application/x-www-form-urlencoded` (an
optional UTF-8 charset is accepted), or `multipart/form-data` with that one field
and value and nothing else. Its separate route budget is 10,000 requests per gym
and client per minute, so junk from other addresses cannot spend a provider's
budget. `POST /l/<token>` is exempt from the app's general flood limit, allowing a
provider to unsubscribe more than 300 members from one address. A token that doesn't
resolve, or that the route's parameter check refuses, is also charged to
`oneClickGuessBudget` (a fixed 300 per gym and client per minute, the flood limit's default),
which refuses that address before any token lookup once spent. Link scripts show
their busy text only for a 429 with the `busy` reason and `limited` for any other. The preference
button/API keeps its 30-request per gym/client/minute budget and general flood limit.
It returns the same 404 for unknown, expired,
revoked, used, wrong-purpose and other gyms' tokens. Cookie-bearing requests
retain the normal same-origin CSRF check. Repeated opt-outs are no-ops. The
separate announcement preference never changes `members.email_opt_out`.

`areas/announcements/unsubscribe.ts` exports `issueUnsubscribeLink(tx, gymId,
memberId, now, token?)`: call it inside a send reservation transaction and use its token
for the message's link and one-click header URL. It stores only the token digest,
expires in 90 days and stays reusable, including after subscribing again. Staff
link lists, lookups, sends and revokes exclude this purpose.
An announcement may supply a cryptographically random 32-byte base64url token to
render before reservation; the helper generates one when omitted.

Add `?tablet=1` for a front-desk tablet:
large controls, a clear-screen action, and a two-minute inactivity reset. The
browser replaces the tablet page when leaving for Checkout, clears its document
on navigation, and reloads restored history entries. No bearer token is placed
in local storage, analytics, third-party assets, or Stripe return URLs.
The two-minute reset runs only on these pages: it cannot run while the tablet is
on Stripe's hosted Checkout page. Staff must clear an abandoned Stripe screen.

Every API request resolves the bearer token into the existing signed-link
principal. The runtime sends the purpose routes (`/api/links/onboarding`,
`pay-invoice`, `update-card`, `sign-waiver`, `unsubscribe` and their subpaths)
through normal session loading; they resolve their own bearer, and kiosk device
tokens grant no link access. The staff link routes keep the kiosk wrapper, so a
device token there answers 404 like other staff routes. Cookie-bearing browser requests keep the normal same-origin CSRF checks.
Its declared purpose permission runs before validation. Reads use
`forHousehold` with the verified link ID and the request clock. The narrow shared
projections exclude contacts, medical data and unrelated invoices or members;
requests cannot add resource selectors. A used credential displays only the
friendly completion page; used, revoked and expired credentials cannot call the
APIs. Pages and responses use `no-store`, no-referrer and noindex headers.
A waiver or onboarding answer's `signatures` are the link's members' signatures of
the current templates only, newest first and at most 100; the checks before an
upload, signature, document or Checkout read the members and templates without them.

Waiver uploads and signatures call the additive `uploadSignedLink` and
`signSignedLink` methods on the waiver service. Each of that service's short
transactions locks and rechecks the link and the member's household, including
after image storage and PDF preflight. The original signing implementation
validates the image, guardian details and current template and persists the
immutable snapshot. The page never supplies document text or a snapshot.
A member waiver link completes with the member's last missing current signature
in the same transaction. The browser reloads after each signature. Pages show
previews only for templates still unsigned, and each unsigned template is
framed once across the household. Document reads have a separate 300-per-minute
budget per gym/client, with a plain retry page for a refused frame or open link.
PDF queue overload shows a retry message rather than a changed-document warning.
Tablet mode
clears only when the server reports completion. An already-fully-signed member's
link completes on first open under the same link lock and shows "already done",
so it needs no dummy signature. Current means the latest version of each family,
excluding retired families. The shared waiver-service check also governs onboarding.
Onboarding keeps the link active until every current document
for its household members is signed and its card setup is confirmed.

Images are uploaded only on submitting a signature. A failed sign or an abandoned
request can still leave an unsigned image. The waiver area's daily image sweep
marks those once they are unreferenced and past their grace period; this page
does not delete potentially signed images.

## Checkout and completion

`createSignedLinkCheckout` lives in `areas/billing/signed-link-checkout.ts`.
It locks/rechecks the link before reading the stored household customer. Both
payment and setup mode use that customer ID; neither uses customer-email mode.
If no customer is linked, the customers service resolves the configured provider,
reserves creation under the household lock, and creates and links a gym-tagged
customer outside the transaction. Existing/imported IDs stay unchanged. Missing
payer details, configuration failures and unresolved creation keep the translated
contact-the-gym state and emit a diagnostic log with identifiers and a reason.
See `areas/billing/customers.README.md` for reservation safety and staff recovery.

Pay links save a card for off-session use only for cycle invoices or assignment
invoices (nonempty lines containing only membership, sign-up fee, discount and
tax), matching the daily runner's shared rule. Other one-off pay links do not save
the card or change the household's default. Card and onboarding links use setup
mode and keep saving cards. The returned or reused Checkout session must match
the expected card-saving policy.

Setup links reuse an open session only after retrieving its current provider state.
The persisted start association identifies the current attempt. A completed or
expired session advances to a new idempotency key derived from that session ID;
concurrent clicks and lost creation responses still share one attempt. Creation
responses are retrieved again before redirecting, because an idempotent POST can
replay its original open snapshot after the session has become terminal. Unknown
sessions stay unavailable until their state can be resolved.

An authenticated setup return, or restarting a completed setup, can recover a
missed webhook. It verifies the gym, link, household customer, persisted session
association, successful SetupIntent and attached method before calling the same
idempotent card writer used by webhooks. Revoked cards remain revoked and late
webhooks remain safe. Invoice payment completion still waits for its accounting
writes. An onboarding return refreshes the page after its bounded checks even
when waivers remain, so the saved card becomes visible without completing the
unfinished onboarding or clearing a signing tablet. Only the server-rendered
card status is updated in place; waiver inputs, signature canvases and the
existing Checkout button remain intact during automatic or manual checks.

Invoice Checkout reserves its idempotency window in `checkout_expires_at`, then
calls the payment provider outside the transaction. The returned session ID is
saved before its URL can leave the service. Both transactions check payable
state, review holds and unresolved runner attempts under the invoice lock.
Concurrent calls share one session. An unknown/lost creation response may be
retried with identical parameters for 23 hours, within provider idempotency
retention. After that, an invoice with no stored session ID receives an audited
new reservation and key under its lock. The previous URL was never disclosed:
responses are saved before returning or expired on failed adoption. Late responses
cannot overwrite a newer reservation. The old key is never reused. A stored
session is replaced only after the provider confirms it expired. When another
pay link opens an invoice's open, link-tagged session, the service expires it,
re-reads it and renews under the invoice lock. If payment wins that race, starting
returns a conflict. Untagged sessions remain shared. Network or revocation errors
never authorize a wider resource.

Starting Checkout does not use the link. The browser receives an authenticated,
HTTP-only return receipt containing the session and link IDs. The provider sees
only the configured origin's `/l/return` URL. The receipt uses AES-256-GCM with a
dedicated HKDF-derived encryption key, authenticated gym/link binding and expiry.
It is HttpOnly, Secure and SameSite=Lax; its path must be `/` to serve both
`/l/return` and `/api/links/*/complete`. Neither its bearer token nor metadata is
readable in the cookie. Old plaintext receipts are rejected; restart Checkout
to obtain an encrypted receipt. It does not grant
any account access. A browser return merely triggers a completion check.

**Webhook-only completion:** Checkout and its setup/payment intent carry `linkId`.
The existing Checkout-start audits target that immutable link ID and store
`{ sessionId }`. After the payment/card writer commits, webhook dispatch awaits
the same `complete` check used by browser return, before marking the event
processed. Setup/payment-intent events find their Checkout only through this
persisted association. Completion never infers a link from a customer, email,
card timestamp or the rotating bearer token. A successful payment intent whose
correctly associated Checkout is still open records the payment without failing
the event; the session-completed event finishes the link. Gym/link mismatches and
missing associations still fail dispatch. Older events without link metadata
retain their existing payment/card behavior. Their browser returns use the
original checks: a paid, partially refunded or refunded invoice, or a completed
setup for the gym and household customer with an unrevoked recorded card.
Onboarding still requires its current waivers. Tagged sessions always require
the exact link and persisted start association.

Invoice completion requires the matching session and paid invoice; card
completion requires the matching setup session and recorded method. Onboarding
additionally checks current signatures and stays pending until those are signed.
Only then does a locked, audited transaction use the link. Replay and concurrent
browser return succeed without a second consumption; revoked and expired links
remain refused. Closing the tab after successful Checkout still completes the
link. A different pay link for the same invoice stays pending when that payment
arrives. Canceled or unfinished Checkout leaves it active. Browser return continues
to check the same results and can finish onboarding after signing. A lost browser
receipt can be recovered by starting Checkout again; provider idempotency
preserves an existing setup within its retention window.

## Composition

The public-area barrel includes these routes. The runtime calls
`configureLinkPages` with:

- `waivers`: the configured waiver service, sharing uploads and clock;
- `checkout`: `createSignedLinkCheckout({ paymentsFor, originFor, clock })`, using
  the same per-gym provider as the webhook inbox and a trusted canonical origin;
- `receiptKey`: a stable secret of at least 32 bytes, derived from the install's
  encryption key with a distinct context, never generated per process;
- optional `gymNameFor(gymId)` for announcement pages; by default the existing
  gym settings service reads the current gym's name;
- the default translator and asset readers. An optional `localeFor(gymId)` resolver
  is supported. The context
  and settings currently have no display-locale field; the resolver defaults to
  `en`. It controls the HTML language, date and money formatting on every page,
  including return and cleared pages, which also use the configured translator.
  Production defaults read `./public/links.css` and `./public/links.js` from the
  server working directory once per process. Missing files log once and return
  an explicit 503; build the files and restart the server to retry.

`pnpm build` calls `buildLinkAssets` from `styles.build.mjs` after the web build,
writing into `apps/web/dist` before copying public assets into the image. The
asset-only command from the repository root is:

```sh
node apps/server/src/public/links/styles.build.mjs apps/web/dist
```

This uses the pinned web Tailwind version and shared design tokens, plus the
existing esbuild toolchain. Browser code is built separately, avoiding server
transpiler helpers in the browser. Generated CSS and JavaScript are not committed.
The stylesheet takes its classes from `page.ts` and `*.page.ts` files under
`public/`, `modules/` (the website), and `demo/` (the public copy prompt), plus the explicit staff invitation source
`areas/staff/profiles.accept.ts`. A new public file that renders markup must be
named `*.page.ts` or added explicitly to the sources, or its classes get no CSS.
`pnpm dev` builds into the ignored `apps/server/public/` directory once at startup,
before starting the server and web watcher. After changing the link styles or
client script, rerun `node apps/server/src/public/links/styles.build.mjs apps/server/public`
or restart `pnpm dev`. From the repository root, using the pinned Node version:

```sh
pnpm dev
```

Rebuild and restart the development server after changing these assets. Production
never builds assets on request.

## Checks

`links.test.ts` exercises real PostgreSQL, production `createApp` registrations,
the real waiver and invoice-transition services, the existing webhook handler,
and fake storage/payments. It covers permission denials, cross-purpose/gym and
household isolation, replay, concurrent operations, expiry and revocation races.

With the separate `e2e` dependencies installed and Edge available, run:

```sh
pnpm --filter @plaingym/server exec tsx src/public/links/tests/browser-check.ts
```

The bounded check verifies all four screens at 360 px and desktop, 44 px controls,
PNG signature capture, two-document waiver and onboarding signing flows, tablet
clearing and inactivity reset, and saves screenshots
under the server's ignored `coverage/signed-links/browser` directory.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Signed-link pages

`/l/<token>` renders invoice payment, card update, member waiver signing, or
household onboarding without a login. Add `?tablet=1` for a front-desk tablet:
large controls, a clear-screen action, and a two-minute inactivity reset. The
browser replaces the tablet page when leaving for Checkout, clears its document
on navigation, and reloads restored history entries. No bearer token is placed
in local storage, analytics, third-party assets, or Stripe return URLs.
The two-minute reset runs only on these pages: it cannot run while the tablet is
on Stripe's hosted Checkout page. Staff must clear an abandoned Stripe screen.

Every API request resolves the bearer token into the existing signed-link
principal. The runtime sends `/api/links/*` through normal session loading;
the link routes resolve their own bearer, and kiosk device tokens grant no link
access. Cookie-bearing browser requests keep the normal same-origin CSRF checks.
Its declared purpose permission runs before validation. Reads use
`forHousehold` with the verified link ID and the request clock. The narrow shared
projections exclude contacts, medical data and unrelated invoices or members;
requests cannot add resource selectors. A used credential displays only the
friendly completion page; used, revoked and expired credentials cannot call the
APIs. Pages and responses use `no-store`, no-referrer and noindex headers.

Waiver uploads and signatures call the additive `uploadSignedLink` and
`signSignedLink` methods on the waiver service. Each of that service's short
transactions locks and rechecks the link and the member's household, including
after image storage and PDF preflight. The original signing implementation
validates the image, guardian details and current template and persists the
immutable snapshot. The page never supplies document text or a snapshot.
A member waiver link completes with the member's last missing current signature
in the same transaction. The browser reloads after each signature; tablet mode
clears only when the server reports completion. An already-fully-signed member's
link completes on first open under the same link lock and shows "already done",
so it needs no dummy signature. Current means the latest version of each family,
excluding retired families. The shared waiver-service check also governs onboarding.
Onboarding keeps the link active until every current document
for its household members is signed and its card setup is confirmed.

Images are uploaded only on submitting a signature. A failed sign or an abandoned
request can still leave an unsigned image. The waiver area's unreferenced-image
cleanup remains necessary; this page does not delete potentially signed images.

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

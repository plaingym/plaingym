<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Public join

`/join` lists the plans a visitor can pay for online: active plans in the gym's
currency with a price and no free trial. Choosing one opens a form for the
payer's contact details and one to six people, each signing every current
document (a parent or legal guardian signs for anyone under 18). It works with
the website module off, keeps the shared public layout, `t()` strings and the
source link, and posts as a native multipart form when JavaScript is unavailable
(PNG signature files replace the canvases). Online joining is unavailable, and
the page says to contact the gym, while billing is off, no payment provider is
configured, or the gym has no current document or more than eight.

## Submission

The join is two requests, like drop-in admission. `POST /join/signatures`
validates the honeypot, plan, availability, every person and current document
version and each bounded PNG, then creates a new household (billing day: the join
date) with its people as prospects and stores the signature images. It never looks
up an address: a new, existing, enrolled or staff email gets the same response and
an existing household is never read or changed. `POST /api/public/join` (the shared
contract) must repeat exactly what was admitted; the private image keys name the
admitted people, and a leaked staff image key cannot enroll an existing member.
It signs the immutable waivers, assigns a pending membership per person, issues one
invoice and a pay link, and answers `received`. Replays and concurrent retries
return the same join. The admission fixes the join date, so a submission retried
after midnight repeats the same memberships; one more than a day old is refused.
Rate limits (ten per gym and address per fifteen minutes for each request) and the
honeypot run before anything is written. Both join requests accept 4 MiB (`joinBodyBytes`):
dozens of drawn signatures, or a family's chosen PNG files (up to 256 KB each). The
install-wide limiter allows the native form twice that, so an oversized form gets join's own
"too large" page (413); the browser checks the size before sending.

The invoice is the household's first cycle: each membership's first full period,
priced by the invoice engine as the runner prices an active membership on its due
date, plus any sign-up fees and their taxes. Each membership is then next due on the
join-date anniversary; an annual membership keeps its join date as its anniversary,
so a February 29 join returns to February 29 in leap years. The pay link's token is
never disclosed: the link only ties Checkout and its webhook completion to the
invoice.

## Checkout and activation

The submission sets an HttpOnly, Secure, SameSite=Lax cookie scoped to `/join` for
two hours. It holds an HMAC-signed reference to the pending join (gym, link and
expiry) and nothing else: no token, claim code or email address. `GET /join/checkout`
starts or reuses Checkout in payment mode through the signed-link Checkout service,
saving the card for later cycles. The session returns only to the fixed pages
`/join/return` and `/join/cancelled` and expires after an hour, and its reservation
renews after that.

Only a recorded payment activates anything. However the invoice is paid (its own
Checkout's `checkout.session.completed`, a later pay link, or cash or a check staff
record), the invoice transitions activate the pending memberships, and their paid-invoice
effect then calls `afterInvoicePaid(gymId, invoiceId)`: the join completes once, turning
the joined prospects into active members and writing `public.join.completed`, and in
passwordless mode the sign-in link goes out. The webhook's `afterCheckout(gymId, linkId)`
does the same for any recorded Checkout of the joined household once the invoice is paid.
Both lock the household and check `public.join.completed`, so together, retried or
concurrent, they complete a join once and send one sign-in link. `/join/return` grants
nothing: it shows "confirming" (refreshing every five seconds) until the invoice is paid,
the memberships are active and the join is complete. A cancelled or expired Checkout
leaves the people prospects and the memberships pending; the daily runner neither charges
nor activates them and holds the invoice for review after seven days. A browser without
the cookie is told what happens next and can do nothing more.

When staff void the unpaid invoice or revoke the join's link, it can no longer be paid
online: `/join/checkout`, `/join/return` and `/join/cancelled` show a closed page that
says to contact the gym, without starting Checkout. A paid invoice wins over a revoked
link, and a Checkout that completed but is still being recorded continues to
`/join/return`.

## Portal login

Passwordless, the portal login proves the address entered: the join's completion issues a
payer invitation for the household's address and sends the portal's claim-code sign-in link
to it (auth mail, not subject to the member-email switch); the household login is created on
its callback only for the signed-in user the code names. `/join/sign-in` sends a new link,
replacing the previous one, with the same response whatever the address.

Password mode has no mail to prove an address, so a paid join provisions no account and sets
no password. Its completion marks the household's address as awaiting portal confirmation
(`requestPortalConfirmation`, `areas/portal/auth.md`), which staff with
`portal_access.manage` see on the household. Staff check the person, then issue the existing
printed payer invitation for that address; the person sets a password on `/portal/claim`, or
enters the current one for an existing account. `/join/return` and `/join/portal-login` say
the gym confirms the portal login, and `/join/portal-login` issues nothing. Staff accounts are
never linked. The join sends no other member-facing mail; receipts follow the transitions'
member-email rules.

## Composition

`configureJoin({ waivers, checkout, paymentsConfigured, invitations, accounts, key })`
supplies the configured waiver service, the same `createSignedLinkCheckout` instance the
webhook completes, a payment readiness check, the runtime's portal invitation service,
the account service and a stable key of at least 32 bytes. It returns the service whose
`afterCheckout(gymId, linkId)` must run in the webhook handlers' `afterCheckoutRecorded`
after the signed-link completion, including when that completion reports the link gone,
and whose `afterInvoicePaid(gymId, invoiceId)` is the transition effects' `afterInvoicePaid`
(`composeBillingWebhooks({ afterInvoicePaid })`).
The routes are already in the public area barrel; unconfigured, they fail closed.

The admission schema is local until it joins the shared public contracts with the
drop-in admission.

## Checks

`join.test.ts` exercises real PostgreSQL, the production route registrations, the real
waiver, membership, signed-link Checkout, invoice-transition and webhook-handler services,
and the runner, with FakePayments. With the separate `e2e` dependencies installed and
Edge available, `pnpm --filter @plaingym/server exec tsx src/public/pages/join.mobile-check.mjs`
checks every join page at 360 and 1280 px (no horizontal scroll, 44 px targets, axe
WCAG A/AA), drawn and file signatures, and the native form.

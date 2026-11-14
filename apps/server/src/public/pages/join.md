<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Public join

Positive first invoices use the shared card minimum and currency-step check before
Checkout. An unchargeable amount shows a manual-payment page, without polling
Stripe or offering Checkout. The registration stays saved with pending memberships;
recording its cash or check payment starts it through the paid-invoice effect:
trial plans enter `trial`, and other plans enter `active`. Legacy off-step invoices
are never silently rounded.

`/join` lists active plans in the gym's currency, including free plans and free
trials. A plan's price and sign-up fee are shown
as listed, followed by "+ tax" when a tax rate attached to the plan is exclusive and
above zero (`plusTax`), whether or not the rate is archived, as the invoices apply
every attached rate; no total is shown. Trial plans also show the number of free
days and explain that any sign-up fee is due today. Choosing one opens a form for the
payer's contact details and one to six people, each signing every current
document (a parent or legal guardian signs for anyone under 18). It works with
the website module off, keeps the shared public layout, `t()` strings and the
source link, and posts as a native multipart form when JavaScript is unavailable
(PNG signature files replace the canvases). Online joining is unavailable, and
the page says to contact the gym, while billing is off, no payment provider is
configured, or the gym has no current document or more than eight.

## Submission

The join is two requests, like drop-in admission. `POST /join/signatures`
validates the honeypot, plan, availability, every person, each required signer
(including guardian rules and bounded signer details), current document version
and each bounded PNG before writing anything. It then creates a new household
(initial billing day: the join date) with its people as prospects
and stores the signature images. A failed upload removes its new prospects and
household and marks any already-uploaded images deleted. It never looks
up an address: a new, existing, enrolled or staff email gets the same response and
an existing household is never read or changed. `POST /api/public/join` (the shared
contract) must repeat exactly what was admitted; the private image keys name the
admitted people, and a leaked staff image key cannot enroll an existing member.
It signs the immutable waivers, assigns a pending membership per person, issues one
invoice and a pay link, and answers `received`. Replays and concurrent retries
return the same join. A submission retried after a plan edit uses the assigned
memberships' trial dates and prices for invoicing and card setup. Before issuing
the first invoice it aligns the household
billing day to their trial end, or keeps the join day for a non-trial membership;
if staff changed the billing day since admission, the submission is refused.
The admission fixes the join date, so a submission retried after midnight repeats
the same memberships. An admission remains valid through
the next calendar day in the gym's timezone and is refused after that day ends.
Rate limits (ten per gym and address per fifteen minutes for each request) and the
honeypot run before anything is written. Both join requests accept 4 MiB (`joinBodyBytes`):
dozens of drawn signatures, or a family's chosen PNG files (up to 256 KB each). The
install-wide limiter allows the native form twice that, so an oversized form gets join's own
"too large" page (413); the browser checks the size before sending.

The daily `public.join.cleanup` batch job removes unsubmitted admissions only when
they are more than 24 hours old and their submission window has ended in the gym's
timezone. The full following calendar day is protected, including across daylight
saving changes. Submission writes `public.join.submitting` under the household lock
before signing or assigning anything; that marker, a received/completed join, a
signed waiver, staff edits, a lead row for a prospect (a staff edit or logged
contact on the Leads screen, or a check-in), a discount staff applied to a
membership, a linked login or a saved card protect the admission.
Cleanup locks the same household and its resources. Its join-specific billing
transition can void an associated open unpaid invoice only for an unsubmitted
admission; a join issues its invoice only after submission has begun, so submitted
joins are left to the unpaid-join void below. Cleanup retains
any paid invoice, payment, unresolved attempt, Checkout reservation/session or
card-setup link. Expiry alone never proves an unknown payment safe to discard.
It removes the prospects and pending memberships, revokes unused links, and marks
signature images deleted through gym-scoped storage outside the transaction.
An invoice keeps its accounting rows and household; an admission without billing
loses its household too. A durable cleanup claim blocks racing submissions and
retains the image prefixes for retries after a storage failure. The job reads
candidates in pages of 100, so protected admissions cannot starve later ones.
When eligibility checks find protected records or staff work, cleanup writes
`public.join.retained` under the household lock. Later runs exclude that admission
before taking its locks, and direct cleanup attempts honor the marker too.

## Unpaid joins

The same nightly job then voids a submitted join whose first invoice is still unpaid
on the seventh calendar day after submission in the gym's timezone (submitted on
March 1, it is payable through March 7 and voided from March 8), across daylight
saving changes. It reads submissions in pages of 100, skipping completed, voided and
retained or stalled joins. Submissions interrupted before their first invoice are
also checked: with no invoice, link, saved card, login or started membership, their
pending memberships are cancelled and reserved uses returned once. An interrupted
submission with other billing or access records is retained for staff.
Before voiding, it asks the payment provider to confirm every Checkout
session the household's links started, and the one the invoice holds, expired
(`expireCheckout`, outside any transaction). It asks nothing for a join staff followed
up with another link, which it keeps (below), so a payer's live session there stays open. A completed session may hold a payment
not yet recorded, and an uncertain answer proves nothing: the join waits, and a later
run asks again. A reserved session whose creation never returned exposed no URL, but
its reservation must have ended. Without a payments resolver (`paymentsFor`), or with
no provider configured, a join that started a Checkout waits. From the 21st local
day after submission, a still-waiting join gets `public.join.void_stalled` in the
staff audit log and automatic checks stop. Its invoice and memberships stay as
they are for staff follow-up; a later recorded payment can still complete it.

Then, in one transaction under the household lock, it locks the household's links,
then its invoices, then its memberships, and checks again. A paid invoice is never
voided: its join completes through the paid-invoice effect. The join is kept for good
(`public.join.retained`, so later runs skip it) when staff or the visitor did more than
the join: another link (other than a spare revoked before use, such as a concurrent
submission's) or invoice, a used link, any payment, charge attempt or saved
card, a review hold other than the runner's overdue hold (the runner holds an unpaid
invoice more than seven days past due; only when the latest invoice hold audit is
`billing.runner.overdue_held` does that hold not protect it), a hold staff
released to collect, a membership added, started or changed in status, or a linked
login. Otherwise it voids the invoice (`billing.invoice.voided`; its lines and
number stay), revokes the join's link, cancels the pending memberships through the
membership service, and, for a join that took a code's uses, ends those applications
with reason `released` and gives the uses back under the discount's row lock
(`billing.discount.uses_released`). It writes `public.join.discount_released` and
`public.join.voided` (invoice, link,
memberships, and the discount and uses released) in the same transaction, so a
replay, a second run or a concurrent one finds the record and releases nothing.

The prospects, their signed waivers and leads, and the household stay for staff
follow-up, as a retained admission's do. The join page then shows the closed page,
Checkout can't start, and a replayed submission returns the same link without taking
a use or starting anything. A payment recorded after the void is refused like any
payment on a void invoice (`Void invoice cannot accept payment`, 409); staff take it
on a new invoice.

Outside a trial, the invoice is the household's first cycle: each membership's first full period,
priced by the invoice engine as the runner prices an active membership on its due
date, plus any sign-up fees and their taxes. Each membership is then next due on the
join-date anniversary; an annual membership keeps its join date as its anniversary,
so a February 29 join returns to February 29 in leap years. The pay link's token is
never disclosed: the link only ties Checkout and its webhook completion to the
invoice.

A trial's initial invoice contains only any sign-up fee and taxes, with no
membership lines. The first full membership period is due at trial end, which
also anchors the household billing day and any annual anniversary. A zero initial
invoice on a plan with a future price uses an undisclosed `update_card` link and
Checkout in setup mode; the recorded setup and saved card must be complete before
the invoice settles to zero. A plan with no current or future charge settles zero
without Checkout. Zero settlement creates no payment or charge, then activates
the memberships and completes the same join once. Positive sign-up fees use
payment-mode Checkout, which saves the card as usual.

## Promo codes

The form has an optional promo code field; both join requests accept it as `code`.
Only a code works on `/join`: a discount without one, or its ID, is never found.
The lookup reads the gym's own discounts (`forGym`), so another gym's code is
unknown. Every refusal (unknown, malformed, without a code, turned off, ended,
used up, another plan, or fewer uses left than people joining) is the same 400
with `details.reason` `code_refused` and one message, so the answer never tells
codes apart; the admission and submission rate limits above bound the guesses.

`POST /join/signatures` checks the code for the plan and the number of people,
under the discount's row lock, before writing anything, and records the discount
with the admission; it takes no use. The submission must repeat that code; any
other code is refused. It checks again before signing or recording leads. Then,
in one transaction, it locks the household and the discount, takes one use per
person (a join that would pass the limit takes none and is refused), assigns
every membership with the discount, records `public.join.discounted`, and issues
the first invoice, so an invoice conflict rolls back the reservation and a replay
or concurrent retry takes no second use. The uses come back, once, only when
the join is voided unpaid (**Unpaid joins**, above). If the uses ran out after
admission, the visitor can clear the field and submit again: the submission
without a code reuses the admission and continues without the discount.

The first invoice prices each first cycle with the snapshot the assignment
took, and a `once` or `cycles` discount uses one cycle there, as the runner does
for a full cycle; a trial's invoice uses none. A fee waiver drops that
membership's sign-up fee. A zero first invoice settles without Checkout when no
later charge is due, using the runner's cycle pricing with family discounts and
integer rounding; finite discounts still require a card for later full-price cycles;
otherwise card setup runs as for a trial. With a code, the script continues to
`GET /join/review`, and the native form's next page, which both show the first
invoice's lines (inclusive taxes left out) and total before payment or card setup.
`/join/review` is read-only and reads only the visitor's own join cookie.

## Checkout and activation

The submission sets an HttpOnly, Secure, SameSite=Lax cookie scoped to `/join` for
two hours. It holds an HMAC-signed reference to the pending join (gym, link and
expiry) and nothing else: no token, claim code or email address. `GET /join/checkout`
starts or reuses Checkout through the signed-link Checkout service: payment mode
for a positive invoice, setup mode for a trial requiring a future payment, and a
redirect to the completed join for a free plan. It saves the card for later cycles.
The session returns only to the fixed pages
`/join/return` and `/join/cancelled` and expires after an hour, and its reservation
renews after that. Setup reservations also persist their exact expiry and attempt
identity before provider calls, so concurrent clicks and a lost creation response
reuse identical parameters.

Only a recorded payment or zero settlement starts a membership. However the invoice is paid (its own
Checkout's `checkout.session.completed`, a later pay link, or cash or a check staff
record), the invoice transitions activate non-trial pending memberships, and their paid-invoice
effect then calls `afterInvoicePaid(gymId, invoiceId)`. Trial invoices contain only
any sign-up fee, with no membership lines that could activate a trial early. Join
completion moves a pending trial membership and its prospective member to `trial`;
other prospective members become `active`. The membership date job activates the
trial at `trialEndsOn`, when the runner bills its first full period. At that
activation a member whose status is still `trial` also becomes `active` if they
have no other trial membership; the member update is audited in the same
transaction. The join
completes once, writing `public.join.completed`, and in
passwordless mode the sign-in link goes out. The webhook's `afterCheckout(gymId, linkId)`
does the same for any recorded Checkout of the joined household once the invoice is paid.
Both lock the household and check `public.join.completed`, so together, retried or
concurrent, they complete a join once and send one sign-in link. `/join/return` grants
nothing: it shows "confirming" until the invoice is paid, the memberships have started and
the join is complete. The confirming page has a spinner with `aria-live` text. It says it is
confirming and points to **Check again** if the page does not change; it does not promise an
automatic update. `/join/client.js` (the page's only script, `'self'`, no inline
script) asks `/join/return` itself with the join cookie about every two seconds and
reloads the page once the answer no longer says it is confirming, so no status route
exists and nothing but the visitor's own cookie is read; after 45 polls (about 90
seconds) it stops, hides the spinner and shows "taking longer than usual" beside the
**Check again** link. Without JavaScript a `<noscript>` meta refresh in the page head reloads
the page every five seconds, and the link works as before. With JavaScript nothing
reloads the page but the poll, so it runs to its limit; if JavaScript is on but the script
doesn't load, nothing reloads the page and only **Check again** moves it on. A cancelled or expired Checkout
leaves the people prospects and the memberships pending; the daily runner neither charges
nor activates them and holds the invoice for review after seven days, and the join cleanup
voids the join on the seventh local day after submission (**Unpaid joins**, above). A browser without
the cookie is told what happens next and can do nothing more.

When the join cleanup voids the unpaid invoice or staff revoke the join's link, it can no longer be paid
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

`configureJoin({ waivers, checkout, paymentsConfigured, invitations, accounts, uploadsFor, paymentsFor, key })`
supplies the configured waiver service, the same `createSignedLinkCheckout` instance the
webhook completes, a payment readiness check, the runtime's portal invitation service,
the account service, gym-scoped uploads for failed-admission compensation and
scheduled cleanup, the runtime's payments resolver for confirming an unpaid join's
Checkout sessions closed, and a stable key of at least 32 bytes. It registers cleanup
with the public jobs barrel and returns the service whose
`afterCheckout(gymId, linkId)` must run in the webhook handlers' `afterCheckoutRecorded`
after the signed-link completion, including when that completion reports the link gone,
and whose `afterInvoicePaid(gymId, invoiceId)` is the transition effects' `afterInvoicePaid`
(`composeBillingWebhooks({ afterInvoicePaid })`).
The routes are already in the public area barrel; unconfigured, they fail closed.

The shared join admission contract requires a signer with each upload. The
drop-in upload contract remains unchanged; join repeats its guardian checks at
submission as the final authority.

## Checks

`join.test.ts` exercises real PostgreSQL, the production route registrations, the real
waiver, membership, signed-link Checkout, invoice-transition and webhook-handler services,
and the runner, with FakePayments. With the separate `e2e` dependencies installed and
the pinned Chromium installed, `pnpm --filter @plaingym/server exec tsx src/public/pages/join.mobile-check.mjs`
checks every join page at 360 and 1280 px (no horizontal scroll, 44 px targets, and
axe WCAG A/AA with JavaScript), trial/free plan forms, a refused and an accepted promo
code with the review step, drawn and file signatures,
and native form layouts and submissions with JavaScript disabled at both widths.
`areas/billing/transitions/join-cleanup.test.ts` covers
invoice safety and cross-gym cleanup against real PostgreSQL. `join.unpaid.test.ts` covers
the unpaid-join void there with FakePayments: the sixth and seventh days across both
clock changes, uses returned once over repeated and concurrent runs, a join paid on the
sixth day, a payment after the void, a completed Checkout, staff follow-up, the runner's
overdue hold, a cleanup without a payments resolver, and cross-gym runs.

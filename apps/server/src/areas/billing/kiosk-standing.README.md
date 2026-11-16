<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Kiosk billing standing

`createBillingStanding(scope)` checks the member's household for a positive
overdue invoice through `forGym`: `amountCents > 0` and either `past_due`, or
`open` with `dueOn` before today in the gym's timezone. The date comes from
`localDate(context.clock.now(), gym.timezone)`. This includes failed sign-up and
manual charges, which remain open, and invoices held for staff review. Open
invoices due today and zero balances do not trigger this check. A missing member fails closed. Members in
another household or gym never affect the result. Settling or voiding the invoice
clears this check. It does not change attendance or invoice state.
`createCreditsStanding(scope)` is a separate provider (id `credits`), so staff see a
credit problem and an overdue invoice together. A member with any class-credit
ledger entry needs a usable, unexpired credit or an active membership (`active` or
`trial`); otherwise it returns `front_desk` with the staff-only `no_credits` reason.
It uses the pack ledger's `lacksClassEligibility`, the rule portal booking and
waitlist promotion also use; an expired lot stops counting at its expiry instant even
before the expiry job runs. Members who have never held credits keep their existing
standing. A household member's credits do not cover siblings.
The kiosk's default standing compositions (name and PIN, and QR) pass their own
database scope to both factories, alongside the inactive-member and waiver checks.

The standing evaluator runs all four providers in parallel, including credits
when billing reports `past_due`, so staff get every reason in one answer. Each
provider owns its short `forGym` transaction; billing first reads gym settings in
another transaction. One evaluation therefore opens five transactions in total,
with up to four held at once. The separate credits connection is intentional;
there is no shared transaction across extension providers. The shipped 1 GB
configuration uses an eight-connection app pool. `kiosk-standing.test.ts` measures
a burst of 12 evaluations using that pool budget, reports duration and peak pool
use in CI, and checks that all 60 transactions finish and return their connections.
This measures pool use, not whole-host memory under a 1 GB cap.

The staff profile reads standing when its tab opens and refreshes it each time
the tab is reopened, so a credit or billing change made in another tab appears
without a page reload. A hash change that names a profile tab
(`#memberTabs.kiosk-standing`) also selects it; other in-page anchors keep the
open tab.

`kiosk-standing.rules.ts` exports `isOverdueInvoice` for the dashboard and the
matching `overdueInvoiceCondition` for SQL. A PostgreSQL parity test checks every
invoice status across date and amount boundaries so the two forms stay aligned.

The provider's reason is internal to standing evaluation. The kiosk check-in
service converts a standing problem to `{ status: 'see_front_desk' }`; it exposes
no invoice, amount, reason, household or member information in that response.
The existing kiosk UI translates that status to its neutral front-desk message.
Staff can inspect reasons through the existing staff-only standing route.

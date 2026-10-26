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
The kiosk's default standing composition passes its own database scope to this
factory, alongside the inactive-member and waiver checks.

`kiosk-standing.rules.ts` exports `isOverdueInvoice` for the dashboard and the
matching `overdueInvoiceCondition` for SQL. A PostgreSQL parity test checks every
invoice status across date and amount boundaries so the two forms stay aligned.

The provider's reason is internal to standing evaluation. The kiosk check-in
service converts a standing problem to `{ status: 'see_front_desk' }`; it exposes
no invoice, amount, reason, household or member information in that response.
The existing kiosk UI translates that status to its neutral front-desk message.
Staff can inspect reasons through the existing staff-only standing route.

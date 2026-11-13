<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing dashboard

`createSkippedCollectionsProvider({ settings })` supplies the admin dashboard's
`billing.skipped-collections` shortlist through the existing count/items extension.
Register it with `configureDashboard` alongside the other alert providers. It requires
`billing.read`, lists up to 20 due open/past-due cycle or membership-assignment invoices below the card minimum
or off the currency step, and links each to its invoice for a manual payment. It counts
all matches in SQL with a capped row query, excludes zero and review-required invoices, hides when empty or billing
is disabled, and sends no email.

`configureBillingDashboard({ settings })` supplies the
settings accessor. Metrics use an aggregate read through
`forGym`; tests can supply `scope` for their isolated database. The runtime configures
it with the same settings accessor used by staff billing routes.
The area barrel registers `/api/dashboard/billing`, and the dashboard page mounts
`BillingDashboardPanel`. HTTP responses are never
cached; browser queries are separated by gym and staff roles. The route and panel
require `billing.read` (owner, admin, front desk). Coaches cannot fetch the panel.

Definitions, also explained on each widget:

* MRR is active membership dues before family discounts and tax. Annual dues are
  divided by twelve, summed with monthly dues, then rounded once to integer cents.
  Trial, frozen and cancelled memberships do not contribute.
* Past due includes `past_due` invoices and unpaid `open` invoices due before
  today in the gym's timezone, with positive amounts only. Invoices held for review
  still count. The kiosk and dashboard share `isOverdueInvoice` and its SQL counterpart.
  Draft, processing, settled and zero-amount invoices do not count.
* Upcoming charges cover today through six calendar days later in the gym's
  timezone. Active and trial memberships estimate one consolidated cycle per
  household and due date, before discounts and tax. Issued cycle invoices replace
  estimates with their actual totals; paid, void, processing and past-due cycles suppress the
  estimate. Only open invoices count here; past-due invoices belong in Past due.
  Open one-off invoices are added separately. The count is labelled Charges,
  because it includes household estimates. This is a preview and
  never generates invoices, advances billing dates or calls a payment processor.
* Open disputes count flagged invoices until `won`, `lost`, `closed` or
  `warning_closed`. Amounts are invoice totals; the locked schema has no separate
  disputed amount. This widget and the independent `billing.disputes` alert are
  omitted when there are no open disputes.

After reading settings, the service calculates all four metrics in one SQL
statement inside a short gym-scoped transaction. Membership estimates are grouped
by household and due date in SQL; issued cycles suppress those estimates before
open invoices are added. Annual normalization sums twelfths using PostgreSQL
numeric arithmetic and rounds only once. No memberships or invoice histories are
paged into Node. Each endpoint holds at most one connection at a time, so loading
the mat and billing endpoints together holds at most two of the eight app pool
connections. Unrelated paid history does not contribute.
The shared `terminalDisputeStatuses` constant defines terminal disputes for the
SQL filter, dashboard and existing alert provider. No new index is needed.

All four metrics share one statement's snapshot. Settings are read in a separate
short transaction, so a concurrent settings change may appear on the next refresh.
All metrics use the gym currency. A membership that is active or due by the
window's end, or an invoice that is past due, open and overdue, due in the
window or openly disputed, in another currency fails closed
instead of displaying false zeroes. The panel refreshes every five minutes,
on focus, and through Refresh billing. Calendar dates are formatted in UTC to
keep their calendar day unchanged in every browser timezone.

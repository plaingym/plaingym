<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing dashboard

`configureBillingDashboard({ settings, memberships, payments })` supplies the
settings accessor and the billing services' read methods. The runtime configures
it with the same membership and payment services used by staff billing routes.
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
  disputed amount. The existing `billing.disputes` alert flag is independent.

The service paginates filtered billing queries in short transactions: active
memberships for MRR, memberships due on or before the upcoming window's end,
past-due invoices, open invoices due before today, invoices in the upcoming window,
and `dispute=open` invoices. It does not page through unrelated paid history.
The shared `terminalDisputeStatuses` constant defines terminal disputes for the
SQL filter, dashboard and existing alert provider. No new index is needed.

Rows are deduplicated by ID across pages. These are point-in-time reads across
several short transactions, not one database snapshot: totals may lag a charge
run in progress. All metrics use the gym currency; invalid data fails closed
instead of displaying false zeroes. The panel refreshes every five minutes,
on focus, and through Refresh billing. Calendar dates are formatted in UTC to
keep their calendar day unchanged in every browser timezone.

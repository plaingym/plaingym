<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Annual billing anniversary

Annual assignments store their resolved first `next_due_on` in
`memberships.anniversary_on`, after trial and household alignment. It can differ
from `starts_on`, including an explicitly supplied renewal date. Monthly
assignments leave it null. Renewals, freezes, and resumes without an explicit date
retain it. An explicit annual due-date edit or resume date sets a new anniversary
when its month or day changes, except that February 28 in a non-leap year retains
an existing February 29 anniversary. An explicit February 28 in a leap year sets
a February 28 anniversary. Switching to monthly clears it; switching to annual
sets it to the resulting due date, including the current due date when unchanged.

Database callers supply a non-null `row.anniversaryOn` as `annualAnchorOn` to
`calculateCycleInvoice` and `calculateFirstPeriod`, omitting it for null rows. The assignment callback's
`billing` instructions already include that input for annual memberships. A
February 29 anniversary clamps to February 28 in a non-leap year and returns to
February 29 in the next leap year, even when the membership started on another
date. Calendar stepping uses the invoice engine's shared-time calendar adapter.

The migration adds a nullable date without backfilling or changing any existing
dates. For older rows with no recorded anniversary, omit `annualAnchorOn` and
retain the calculators' existing fallback. The membership HTTP contract is
unchanged; the anniversary is available to database billing callers and in the
assignment's audited billing instructions.

## Custom prices

A membership copies its plan's price when assigned and keeps it when the plan's price changes. Staff can give one member a custom price from the member's Memberships tab: it sends the `price` override (amount and the membership's currency) on `PATCH /api/billing/memberships/{membershipId}`. A plan change takes the new plan's billing interval unless `interval` is sent too (the tab never sends it); sent without a `price` it also takes the new plan's price, and sent with a `price` it keeps the entered amount.

When the membership amount differs from the plan's current amount, the card
shows "Plan price now" with that amount and billing interval. This covers both
a price entered by staff and a price retained after a plan change. The comparison
appears only when the membership and plan share a currency and billing interval.

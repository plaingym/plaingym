<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Annual billing anniversary

## Lead conversion

Activating a pending or trial membership marks its member's lead `won` in the
same transaction, including activations from a paid invoice's effect. An
assignment that starts active does the same. This includes previously lost
leads, increments the lead revision and audits the caller's actor once. A
prospect or trial member without lead details gains a null-source lead; other
members without a lead gain none. Repeated effects, trial assignments and frozen
resumes leave lead stages unchanged. Direct membership imports change no stage.

## Anniversary dates

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

## Scheduled plan switches

`switchPlan(context, { membershipId, revision, requestId, planId, timing: 'next_billing_date', override? })`
schedules a switch to another plan on the membership's next billing date. It
moves no money now. There is no HTTP route for it yet. The rules and the apply
step live in `memberships.plan-change.ts`.

- It locks the household, then the membership (the cycle build's order). A
  request ID already recorded for the membership returns the recorded membership
  without writing, even with the old revision, so a retry after a lost response
  replays. The same ID with another plan, timing or override flag is a conflict.
  A new request then needs the current revision.
- The plan must be active, in the membership's currency and not its current plan;
  the membership must not be cancelled and its member must not be erased. Conflicts
  carry a `reason` (`plan_inactive`, `currency`, `same_plan`, `cancelled`,
  `erased`, `commitment`). Another gym's membership or plan is not found.
- A switch is a downgrade when the new plan's price per year (a monthly price × 12)
  is below the membership's current price per year, an upgrade when above, and
  equal otherwise. A downgrade while `commitment_ends_on` is after the gym's local
  today is a `commitment` conflict unless the request has an override reason
  (1–500 characters). On or after that day no override is needed, and an upgrade
  is never blocked.
- It stores the plan, the plan's current price and interval, and the membership's
  next due date in the four `scheduled_*` columns, which `Membership` returns
  read-only. A new switch replaces a scheduled one. An override reason the
  commitment needed goes in `switch_override_reason`, which no response or audit
  carries; one it didn't need isn't kept. The audit
  `billing.membership.switch_scheduled` records the request (plan, timing,
  request ID, whether it carried an override) and whether the override was used
  (`overrideUsed`).
- The new plan's trial days, sign-up fee and commitment length are ignored; the
  membership keeps its status and `commitment_ends_on`.

The charge runner's cycle build calls `applyScheduledSwitch(tx, row, clock)` for
each membership due in the cycle, before pricing it (`runner/README.md`). It applies
an active membership's switch dated on or before its next due date. The membership
takes the plan, the quoted amount and the interval. A switch to annual starts the
anniversary on that due date, or keeps an annual membership's anniversary. A switch
to monthly clears it. The scheduled columns are cleared, the revision is bumped and
`billing.membership.plan_switched` is audited with the system actor. A scheduled
change whose plan is the current plan changes only the price. Pending, trial and
frozen memberships keep their switch until a cycle bills them as active. A frozen
membership's skipped cycles don't apply it.

`cancelScheduledSwitch(context, { membershipId, revision })` clears a switch that
hasn't applied yet and audits `billing.membership.switch_cancelled`. A membership
with no switch scheduled is a `none_scheduled` conflict. Cancelling the
membership, member erasure, and a `PATCH` that changes the plan or interval also
drop a scheduled switch; a `PATCH` that changes only the price or due date keeps
it. Clearing a scheduled switch also clears its override reason. After a switch
applies, its reason stays on the membership until the next switch is scheduled or
the member is erased.

## Custom prices

A membership copies its plan's price when assigned and keeps it when the plan's price changes. Staff can give one member a custom price from the member's Memberships tab: it sends the `price` override (amount and the membership's currency) on `PATCH /api/billing/memberships/{membershipId}`. A plan change takes the new plan's billing interval unless `interval` is sent too (the tab never sends it); sent without a `price` it also takes the new plan's price, and sent with a `price` it keeps the entered amount.

When the membership amount differs from the plan's current amount, the card
shows "Plan price now" with that amount and billing interval. This covers both
a price entered by staff and a price retained after a plan change. The comparison
appears only when the membership and plan share a currency and billing interval.

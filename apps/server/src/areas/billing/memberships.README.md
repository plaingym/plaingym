<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Annual billing anniversary

## Discounts at assignment

The staff assignment API accepts one optional `discount`, selected by
`discountId` or a case-insensitive `code`, under the existing `plans.manage`
permission. Its active state, local end date, use limit and plan eligibility are
checked under a row lock inside the assignment transaction. Uses and membership
terms commit together; replaying the internal assignment ID consumes no second
use, and reusing it with another discount is a conflict. The response's
`discount` is the live snapshot (name, terms and cycles left) or null.

First-period invoices receive the discount; a waived signup fee creates no fee
invoice. Fee-only waivers complete at assignment. Full cycle invoices, including a
first period that bills a whole period, consume a `once` or `cycles` allowance,
while prorations, trials and frozen skipped periods do not. A zero first invoice settles and activates through the normal runner and
transition jobs. Catalog edits leave existing application terms unchanged.

## Lead conversion

When a trial membership activates, its member also becomes `active` if their
status is still `trial`, they have not been erased, and they have no other trial
membership. This applies to online joins and staff-set trials. The member update
uses a revision guard and writes `billing.member.activated` in the membership's
transaction. Other member statuses stay as set by staff. Household locks serialize
sibling activations and assignments, so concurrent trial endings promote once.

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
a February 28 anniversary. The interval changes only when a scheduled plan switch
applies (below): a switch to monthly clears the anniversary, and one to annual
starts it on the due date the switch applies on.

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

## Plan switches

A membership's plan and billing interval change only through a plan switch.
`PATCH /api/billing/memberships/{membershipId}` refuses `planId` and `interval`
(a 400), and the service's `update` refuses them too. The lifecycle interface's
`changePlan` schedules a switch for the next billing date. Three routes, all for
owners and admins (`plans.manage`), cover switching:

| Route | What it does |
| :--- | :--- |
| `POST …/{membershipId}/switch` | `{ revision, requestId, planId, timing?, override? }`: switches on the next billing date (`timing` omitted or `next_billing_date`) or `now`. Returns `{ membership, invoiceId }`; `invoiceId` is the upgrade's proration invoice, or null. |
| `POST …/{membershipId}/switch/cancel` | `{ revision }`: cancels a scheduled plan switch that hasn't applied yet. Returns the membership. A price change left by a downgrade now isn't cancelled (`price_change`); a price edit replaces it. |
| `GET …/{membershipId}/switch/preview?planId&timing` | What the switch would do, without writing: the kind (`upgrade`, `downgrade`, `equal`), the date the new price starts, whether the commitment blocks it, and for an upgrade now the period, the days charged, the period's days and the invoice total (0 when none would be issued). It refuses what the switch refuses, except the commitment, which it reports. |

`switchPlan(context, { membershipId, revision, requestId, planId, timing, override? })`
behind the switch route takes the household lock, then the membership's. The
rules and the apply step live in `memberships.plan-change.ts`; the "now" timing
and the preview in `memberships.plan-change.now.ts`.

- A request ID already recorded for the membership (a scheduled switch's or a
  switch made now's audit) returns the recorded membership and invoice ID without
  writing, even with the old revision, so a retry after a lost response replays,
  and a double submit waits on the household lock and replays. The same ID with
  another plan, timing or override flag is a conflict; a different override reason
  alone isn't told apart, since the audit never holds the reason. A new request
  then needs the current revision.
- The plan must be active, in the membership's currency and not its current plan;
  the membership must not be cancelled and its member must not be erased. Conflicts
  carry a `reason` (`plan_inactive`, `currency`, `same_plan`, `cancelled`,
  `erased`, `commitment`, and for "now" `not_active`, `interval_change`,
  `period_not_billed` and `tax_change`). Another gym's membership or plan is not
  found.
- A switch is a downgrade when the new plan's price per year (a monthly price × 12)
  is below the membership's current price per year, an upgrade when above, and
  equal otherwise. A downgrade that takes effect before `commitment_ends_on` (on the
  next due date for a scheduled switch, the gym's local today for "now") is a
  `commitment` conflict unless the request has an override reason (1–500
  characters). One that takes effect on or after that day needs no override, and an
  upgrade is never blocked.
- On the next billing date, it stores the plan, the plan's current price and
  interval, and the membership's next due date in the four `scheduled_*` columns,
  which `Membership` returns read-only, and moves no money. A new switch replaces
  a scheduled one. An override reason the commitment needed goes in
  `switch_override_reason`, which no response or audit carries; one it didn't
  need isn't kept. The audit `billing.membership.switch_scheduled` records the
  request (plan, timing, request ID, whether it carried an override) and whether
  the override was used (`overrideUsed`).
- The new plan's trial days, sign-up fee and commitment length are ignored; the
  membership keeps its status and `commitment_ends_on`.

### Switching now

"Now" is only for an active membership, keeps its billing interval (a new interval
starts on a due date), and needs the current period billed. Otherwise it is a
conflict: `not_active` for a pending, trial or frozen membership, `interval_change`,
or `period_not_billed`. The period counts as billed when the cycle due on an earlier
date has run (the next due date is not before the gym's local today) and, for an
upgrade with days left, when a membership line for this membership sits on an
invoice that isn't void or fully refunded and is due within the current period (its
cycle, its first period, or an earlier switch), and no staff price edit has changed
the membership's price since the first such invoice was issued. A freeze resumed
early, a trial activated early, a first period left to the next billing date, an
imported membership, a refunded period or a price edited mid-period leaves the days
left unpaid at the current price: an upgrade now is refused rather than charged a
difference against them, and the next billing date still works. An upgrade now
between plans that carry different tax rates is refused too (`tax_change`): the
proration adds the new plan's taxes to the price difference, which is exact only
when both plans carry the same rates.

- **Upgrade:** in the one transaction, the membership takes the new plan and its
  price, any scheduled switch is cleared, and the runner's `issue` writes the
  proration invoice from the invoice engine's `calculatePlanChange` (the new price
  minus the current one for the days left, with the household discount and the new
  plan's taxes; due on the gym's local today; its membership line records the new
  plan). With no days left (the switch falls on the due date) or a proration that
  rounds to 0 there is no invoice, and a total of 0 (a full household discount) is
  not issued either. After commit the route runs the collection hook, which
  charges the household's new assignment-kind invoices with the saved card. A
  provider failure never undoes the switch: the daily sweep and dunning carry on as
  for any assignment invoice. A replayed request runs the hook again, which charges
  an invoice no attempt has reached (the process stopped before collecting) and
  leaves one already attempted alone. Paying the invoice changes nothing on the
  active membership.
- **Downgrade or equal:** the membership takes the new plan at once and keeps its
  current price until the next due date, through a price change scheduled on the
  new plan (the four `scheduled_*` columns, with the new plan as both the current
  and scheduled plan), which the cycle build applies like any scheduled change. No
  invoice, refund or credit. An equal switch has no price to change and schedules
  nothing.
- Either audits `billing.membership.plan_switched` with the request, whether the
  override was used, the kind and the invoice ID (or null). The price change a
  downgrade leaves can't be cancelled (`price_change`), since that would keep the
  new plan at the old price; a price edit replaces it and keeps the override reason
  of the switch that applied.

The charge runner's cycle build calls `applyScheduledSwitch(tx, row, clock)` for
each membership due in the cycle, before pricing it (`runner/README.md`). It applies
an active membership's switch dated on or before its next due date. The membership
takes the plan, the quoted amount and the interval. A switch to annual starts the
anniversary on that due date, or keeps an annual membership's anniversary. A switch
to monthly clears it. The scheduled columns are cleared, the revision is bumped and
`billing.membership.plan_switched` is audited with the system actor. A scheduled
change whose plan is the current plan changes only the price. Pending, trial and
frozen memberships keep their switch until a cycle bills them as active. A frozen
membership's skipped cycles don't apply it. A switch to a plan archived after it was
scheduled still applies at its quoted price, as an archived plan keeps the members
already on it.

`cancelScheduledSwitch(context, { membershipId, revision })`, behind the cancel
route, clears a plan switch that hasn't applied yet and audits
`billing.membership.switch_cancelled`. A membership with no switch scheduled is a
`none_scheduled` conflict, and a price change left by a downgrade now is a
`price_change` conflict. Cancelling the membership, member erasure and a new
switch also drop a scheduled switch. A `PATCH` with a price replaces a scheduled
price change and is a `switch_scheduled` conflict while a plan switch is scheduled
(its quoted price would overwrite the edit on the due date). A `PATCH` that moves
the due date before a scheduled change's date moves that date with it, so the change
still applies at the next billing; a later due date keeps it. Clearing a scheduled
switch also clears its override reason, except a price change left by a switch made
now, whose switch has applied. After a switch applies, its reason stays on the
membership until the next switch is scheduled or the member is erased.

## Custom prices

A membership copies its plan's price when assigned and keeps it when the plan's price changes. Staff can give one member a custom price from the member's Memberships tab: it sends the `price` override (amount and the membership's currency) on `PATCH /api/billing/memberships/{membershipId}`, which also takes a new `nextDueOn`. The tab's edit form has no plan select: a plan changes through a plan switch.

The same tab (owners and admins) has a **Change plan** dialog on each live membership. It lists the active plans in the membership's currency other than its current plan, with "on the next billing date" preselected and "now" disabled (with the reason) for a membership that isn't active or a plan with another interval. It shows the server's preview before confirming, asks for a reason only when the preview says the commitment blocks the switch, and generates one request ID per distinct submission while it is open, so a retry replays. A stale revision reloads the membership and says it changed. A scheduled switch or price change shows on the card ("Changes to <plan> on <date>" or "New price <price> from <date>"). A scheduled plan switch has a confirmed **Cancel change**, and the price form says to cancel it before changing the price; a scheduled price change has no Cancel change, and the price form says a price entered there replaces it.

When the membership amount differs from the plan's current amount, the card
shows "Plan price now" with that amount and billing interval. This covers both
a price entered by staff and a price retained after a plan change. The comparison
appears only when the membership and plan share a currency and billing interval.

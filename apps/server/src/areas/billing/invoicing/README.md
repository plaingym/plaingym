<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Invoice calculations

`calculateCycleInvoice` takes frozen `MembershipSnapshot` values, descriptions,
and resolved tax rates. It calculates one household's invoice for **one exact due
date**. Active memberships on other dates are left for separate invocations.
Pending, trial, and cancelled memberships are excluded. Frozen memberships produce
only a skipped due-date advance; the lifecycle service must resume them explicitly.
A frozen membership whose scheduled resume date has arrived (on or before the due
date) is neither skipped nor billed: that cycle is owed, so it waits for the resume
and is then billed as active. Run the lifecycle's date job before the charge run.
An empty or entirely frozen cycle has no invoice. Free active plans produce a
zero-total invoice and advance normally.

There is no database access, clock read, ID allocation, state transition, or I/O.
Inputs are not mutated. All outputs use integer minor units and the supplied gym currency;
membership and charge currencies must match it. Lines are projections of the shared
`InvoiceLineItem` contract without persistence IDs. No dependency was added.

Each membership line records its membership's plan in `planId`: cycle lines, the
off-day stub and the prorated first period; a plan change's proration line
records the plan switched to. A signup-fee charge must pass its plan as
`planId` (one without it is refused) and its line records it; the runner's assignment invoices and the join
flow do this. Charge, discount and tax lines always have a null `planId`, and a
charge that passes one is refused. The revenue report groups a line by this plan,
so a later plan change on the membership doesn't move revenue already billed.

## Calendar

Callers turn the injected clock's instant into the gym's date with
`localDate(clock.now(), timezone)` from `@plaingym/shared/time`, then select due
dates oldest first. Monthly dates use the household's original billing day, clamped
to the destination month: January 31 → February 28 → March 31. A monthly membership
due off that day (a trial that ended mid-cycle, or a household whose billing day
changed) is billed only for the days up to the household's next billing day,
prorated like a first period, and then joins it: a trial ending March 10 in a
household billed on the 1st pays 22/31 of a month, then bills on April 1. A frozen
off-day date skips to that billing day. Annual dates use
their own month and anniversary, independently of the household billing day.
`annualAnchorOn` preserves February 29 through non-leap years. Cycle calculations
default that anchor to `nextDueOn`, preserving an original February 29 `startsOn`
when the renewal has clamped to February 28. For imported anniversaries that differ from the start date, callers
should supply the original anniversary explicitly, including on later runs.

`calculateFirstPeriod` bills `[startsOn, nextDueOn)` using the actual number of
calendar days in the monthly/annual interval immediately preceding `nextDueOn`.
It rounds `price × remaining days / interval days` once, then applies the membership
discount, family discount and tax. DST never turns a day into a fractional day. It returns a
separate `one_off` invoice due on `startsOn`, with period metadata beside it.
`next_billing_date`, zero-length periods, and trial, frozen, or cancelled
memberships produce no first-period invoice (and report zero billed days): a
trial is free until it ends, however long, and its first bill is the cycle on its
due date. Pending memberships can have a first
payment calculated; the caller coordinates activation through the lifecycle.
An assignment starting before the preceding interval is rejected, not silently
charged for more than a full period. New households pay a full period through
their onboarding flow rather than this existing-household proration function.

`calculatePlanChange` (`plan-change.ts`) quotes an upgrade that takes effect now:
the new plan's price minus the membership's current amount (a custom price
counts as the current price), for the days left in the current period. Optional
`currentDiscount` and `newDiscount` describe each side: pass both to keep a
discount, or only `currentDiscount` when it ends. The current price is credited
after its membership discount, before the new side's discount is applied. That
period is the monthly or annual interval immediately before `nextDueOn`, as for
a first period, except that a monthly due date off the household's billing day
(left by a changed billing day) closes a full month on its own day. If that date
is the last day of a short month, the original billing day is ambiguous. The
switch service uses the latest membership cycle bill's due date to supply
`billedPeriodStartsOn`: February 28 can close a period beginning January 28, 29,
30 or 31. The engine validates that date between the due date's own day a month
earlier and the previous month's last day. One-off switch invoices don't reset
that start, and neither does a cycle bill after the previous month's last day
(a due date edited mid-period). Without such a cycle bill, the engine uses the due date's own day a month
earlier; a clamped day-31 period is then approximated (January 28 to February 28
instead of January 31 to February 28). The days left
run from the later of `changeOn` and `startsOn` to `nextDueOn`. The difference is
quoted like a first period of the new plan: `difference × days left / period
days`, rounded once to the currency's step. The new discount comes off that
quote (a percentage of the prorated **new price**, or a fixed amount prorated by
the same days), then the household discount, then the new plan's taxes. For
example, changing from 100 to 200 with a fixed 20 discount kept on both sides
quotes 120 before the new 20 discount for a full period, leaving 100. No charge
is quoted when the new effective price is no higher than the current one, even
if the sticker price increased. Ending a discount can increase the effective
price even when the sticker price falls. The result is a `one_off` invoice due on
the later of `changeOn` and `startsOn`, with one
`membership` line that records the membership and the **new** plan, then its
discount and tax lines, and the period with its billed and total days beside it.
The membership description names the current discounted per-period credit before
proration. A percentage discount uses the actual extended gross at calculation
time; plan changes explicitly supply the prorated new price as its discount base
because the membership line already includes the current-price credit.
There is no invoice (and zero billed days) when the new effective price isn't
higher, the change is on or after the due date, the rounded proration is zero, or the
membership is in a trial, frozen or cancelled. A plan with another billing
interval is refused with a `RangeError` (an interval change is never prorated),
as is a change dated before the current period or to the membership's current
plan. Target tax rates are validated even when no invoice is produced.
`changeOn` is the gym-local date
from `localDate(clock.now(), timezone)`; days are calendar days, so DST never
changes them. The membership service's switch made now calls it (`memberships.README.md`).

`calculateOneOffInvoice` handles sign-up fees and other standalone charges without
a family discount. Quantities are extended before tax rounding; output amounts
are additive totals with quantity 1. Sign-up fees are separate from prorated and
recurring membership invoices.

## Membership discounts

`PricedMembership.discount` is optional. A `MembershipDiscount` has the source's
`name` and either `{ kind: 'percentage', basisPoints }` (0–10,000) or
`{ kind: 'fixed', amountCents }` (nonnegative integer minor units in the invoice
currency). It comes off the membership's actual price, including a custom price,
before the household's family discount and before tax. Each deduction has its own
`discount` line, named after its source and linked to the membership, with no
`planId`. Zero deductions produce no line. A fixed amount is clamped to the price;
100% leaves zero to tax or discount further. Discount lines are negative, while
each membership's amount after its deductions and every invoice total stay
nonnegative.

For first periods, off-day cycle stubs and immediate plan changes, percentages
apply to the rounded prorated price. Fixed amounts are prorated by the same
calendar-day fraction as the price, rounded to the currency's step and clamped
to the amount being billed. The caller resolves applicability and the name;
these functions do not read discount records or decide dates. Omitting the
optional discount inputs preserves existing calculations. Signup-fee waivers
need no discount calculation: the caller leaves the fee out.

## Rounding

All multiplication/division uses `bigint`; output line amounts and invoice totals
must fit PostgreSQL signed integer cents. Nonnegative rational amounts round to
the nearest multiple of the currency's charge step (`minorUnitStep` from
`@plaingym/shared/money`), with exact halves rounded upward: one minor unit for most
currencies, 100 for ISK and UGX (Stripe charges them in whole units written with two
decimals), and 10 for BHD, JOD, KWD, OMR and TND (Stripe wants a last digit of 0).
Prorations, membership and family discounts, the net of an inclusive quote and
each exclusive tax round to that step, and allocations hand out whole steps, so every line and the
total of an invoice whose prices are on the step land on it too: 5 ISK with 11 % tax
on top is 6 ISK, never 5.55. An invoice with a price stored off the step (from before
prices were checked) is calculated in single minor units, as before; the charge runner
then skips it (`off_step`) and leaves it for a manual payment.

1. Round and clamp each membership's discount, then round the household percentage
   discount **once** on the sum of the remaining membership quotes. Allocate that
   amount proportionally to those remaining quotes by largest remainder, breaking
   ties by membership ID. The configured household
   discount applies even when only one membership is due on this date.
2. Each quote includes only its inclusive taxes. Extract its net amount by rounding
   `quote × 1,000,000 / (1,000,000 + sum of inclusive rates)`, both before and after
   each discount. The membership line is the original net; separate membership
   and family discount lines reduce it to each successive net. Thus a discount on
   an inclusive quote reduces both its pre-tax price and its included tax.
3. The discounted quote minus its rounded net is the exact included-tax budget.
   Allocate that budget proportionally among inclusive rates by largest remainder,
   breaking ties by tax-rate ID. This keeps every quoted cent accounted for even
   when several rates share a fraction of one cent. Inclusive taxes are split out
   of the quote and added as separate lines, never added twice.
4. Each exclusive rate is rounded separately on the discounted, rounded net.
   All rates share that pre-tax base; taxes never compound. Tax rounding happens
   per membership/charge, not on invoice-wide grouped bases. Every applied rate
   has its own tax line, including zero amounts, linked to its membership/charge
   when applicable. The line snapshots the rate ID, name, millionths and treatment.
5. The invoice total is the sum of **all** line amounts (discounts are negative).

Input tax order and membership order do not affect a cycle's result. Duplicate
memberships, duplicate rates on a charge, and conflicting snapshots of one rate
are rejected. Callers resolve rates already attached to a plan/charge; the engine
does not reinterpret a catalog rate's active flag or fetch current prices.

## Persistence caller

The issuing service must reload gym/household-scoped snapshots through `forGym`,
calculate, and atomically persist invoice lines and due-date advances using the
returned `expectedRevision` and `previousDueOn`. Hold the appropriate membership
locks/check revisions; a calculation is not a reservation. Cycle uniqueness is
enforced by `(gym_id, household_id, kind, due_on)`. On a repeated run, reuse the
existing invoice without advancing memberships again. Advance frozen skips even
when there is no invoice. If a consolidated invoice contains annual and monthly
memberships, its period ends at the latest line's next date; individual recurrence
dates remain available in `nextDueDates`.

Allocate the display number with `allocateInvoiceNumber(tx, gymId)` **in the
issuing transaction**, add UUIDv7 IDs and timestamps, and write the audit there.
Drafts have no number; discard abandoned drafts. Payment outcomes belong to the
invoice transitions, and all external charging occurs after commit. The charge
runner owns catch-up review, billing-enabled checks, and issue/payment state.

No runtime mounting is needed for these pure functions. Consumers import this
directory's `index.ts`; `pricing.ts` holds the validation, calendar and pricing
internals the calculators share. Existing empty route/job registrations remain unchanged.
The local calendar adapter uses the shared time module's validated calendar dates
and `addDays` operations. TODO: move anchored month/year stepping and calendar-day
differences into that module.

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
Inputs are not mutated. All outputs use integer cents and the supplied gym currency;
membership and charge currencies must match it. Lines are projections of the shared
`InvoiceLineItem` contract without persistence IDs. No dependency was added.

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
It rounds `price × remaining days / interval days` once, then applies the family
discount and tax. DST never turns a day into a fractional day. It returns a
separate `one_off` invoice due on `startsOn`, with period metadata beside it.
`next_billing_date`, zero-length periods, and trial, frozen, or cancelled
memberships produce no first-period invoice (and report zero billed days): a
trial is free until it ends, however long, and its first bill is the cycle on its
due date. Pending memberships can have a first
payment calculated; the caller coordinates activation through the lifecycle.
An assignment starting before the preceding interval is rejected, not silently
charged for more than a full period. New households pay a full period through
their onboarding flow rather than this existing-household proration function.

`calculateOneOffInvoice` handles sign-up fees and other standalone charges without
a family discount. Quantities are extended before tax rounding; output amounts
are additive totals with quantity 1. Sign-up fees are separate from prorated and
recurring membership invoices.

## Rounding

All multiplication/division uses `bigint`; output line amounts and invoice totals
must fit PostgreSQL signed integer cents. Nonnegative rational amounts round to
the nearest cent, with exact halves rounded upward.

1. Round the household percentage discount **once** on the sum of the membership
   quotes being billed. Allocate that amount proportionally to their quotes by
   largest remainder, breaking ties by membership ID. The configured household
   discount applies even when only one membership is due on this date.
2. Each quote includes only its inclusive taxes. Extract its net amount by rounding
   `quote × 1,000,000 / (1,000,000 + sum of inclusive rates)`, both before and after
   discount. The membership line is the original net; a separate discount line
   reduces it to the discounted net. Thus a discount on an inclusive quote reduces
   both its pre-tax price and its included tax.
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
directory's `index.ts`; existing empty route/job registrations remain unchanged.
The local calendar adapter uses the shared time module's validated calendar dates
and `addDays` operations. TODO: move anchored month/year stepping and calendar-day
differences into that module.

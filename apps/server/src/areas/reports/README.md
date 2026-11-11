<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reports

`GET /api/reports/attendance?from=2026-01&to=2026-11&granularity=month`
returns attendance grouped by program and calendar period. `reports.read` grants
access to owners, admins and coaches; front desk staff and members cannot read
reports. Responses carry `Cache-Control: no-store`.

`reportsContracts` in `@plaingym/shared/contracts` holds the route and response
shape. `reportRangeQuerySchema` validates inclusive `YYYY-MM` months, in order,
with at most 24 months. `reportBuckets` also rejects an end month after the gym's
current local month using the request clock. It returns monthly buckets by default
or Monday-based weeks, with exclusive end dates and instants. The first and last
weeks are clipped to the requested months and marked `partial` when clipped.
Monthly buckets cover whole local months, including the current month.

All boundaries are local midnights converted by `@plaingym/shared/time` with
`gap: 'shift'`. Weeks across daylight-saving changes can have 167 or 169 hours.
SQL joins the supplied instant boundaries; it performs no timezone conversion.

`createAttendanceReportService` takes `forGym` (overridable in tests) and receives
gym ID, timezone and clock on each call. The route gets these from request context;
no separate runtime configuration is required. `attendance.query.ts` runs one
parameterized aggregate statement inside one `forGym` transaction for any range.
`statements.test-helper.ts` measures actual driver statements and elapsed time,
with transaction/setup statements separated from report SQL, using an app-role
connection and the real scope.

Each bucket contains program IDs and current names, check-ins and unique members,
plus overall totals. Archived programs and imported check-ins count. Programs
come from the visit's direct program and its session's current program links,
matching attendance totals; duplicate links count a visit once per program.
An unassigned visit has null program ID and name, for display as **No program**
with localized client text. Empty buckets have no program rows and zero totals.
A multi-program visit can appear in several program rows, while overall totals
count each check-in and each member once. Program names and all attendance reads
stay inside the gym's forced RLS context.

## Members

`GET /api/reports/members?from=2026-01&to=2026-11` returns monthly member
activity. It requires both `reports.read` and `billing.read` (owners and admins)
and sends `Cache-Control: no-store`. The inclusive range has the same 24-month
limit and gym-local month boundaries as attendance; there is no granularity option.

Each bucket has `activeAtStart`, `new`, `imported`, `cancelled`, `netChange`,
`activeAtEnd`, `frozenAtEnd`, and `churn`. Churn is an integer `numerator`
(cancelled) and positive `denominator` (active at start), or null when the
denominator is zero. Clients format the percentage.

Activity starts at the first active assignment, activation or membership import
audit event, regardless of a backdated `starts_on`. Pending and trial memberships
do not count until activation. Cancellation uses `memberships.cancelled_at`,
including member erasure; erased members remain in historical counts. Freezes
remain active, and freeze/resume events determine frozen intervals. An active or
frozen row without activation evidence falls back to `starts_on` at local midnight
only when its audit history does not identify an unconverted pending/trial
membership. A frozen trial has never become active and does not count;
a cancelled row without activation evidence never counted. A freeze from
`active` that comes before any activation shows the row was already active, so
it also uses the `starts_on` fallback (cancelled or not), and its later resume
is not counted as new. Directly seeded frozen
rows use `frozen_at` (or their start when absent).

The service unions each member's overlapping or touching memberships before
counting entries and exits. Cancelling one overlapping membership is not churn.
Leaving and returning counts a cancellation and a new entry, including within
one month. An activity interval starting with an import enters `imported` instead
of `new`; an overlapping addition never adds another member. A member with any
live frozen membership counts once in `frozenAtEnd`.

Snapshots are immediately before local midnight at the boundary: an activation
exactly on the first enters that month's `new` or `imported`; a cancellation
exactly on the first is in that month's `cancelled`. This preserves
`activeAtStart + new + imported - cancelled = activeAtEnd` and continuity
between adjacent months. Current-month buckets cover the full calendar month.

`members.query.ts` joins memberships to the four lifecycle audit actions in one
statement in one `forGym` call, using the gym/action/target audit index. This keeps
the membership rows and their history in the same database snapshot. The
TypeScript service reconstructs live and frozen intervals without a history table.
The existing reports route barrel mounts it; no extra runtime wiring is needed.

## Revenue

`GET /api/reports/revenue?from=2026-01&to=2026-11` requires both
`reports.read` and `billing.read` (owners and admins). The same inclusive,
at-most-24-month range and current-local-month limit apply. Responses carry
`Cache-Control: no-store` and contain separate `currencies`, each with monthly
`buckets`, `groups`, and `totals`; there is no combined currency total. A currency
with activity has every requested month, including zero months. With no activity,
`currencies` is empty. Amounts are integer minor units, including whole yen.
The route also requires an owner or admin role before validation: combining coach
and front desk capabilities does not grant revenue access.

Payments count in the gym-local month of `paid_at`, across card, cash, check and
other methods. Only `succeeded` refunds count, in the local month of `resolved_at`;
their invoice and payment can predate the report. A later refund reduces its own
month, leaving the earlier payment month unchanged. Pending, failed and canceled
refunds and disputes do not reduce revenue. No invoice means no revenue, including
a frozen month without an invoice.

Payment amounts up to the invoice amount are allocated proportionally to its
signed line amounts using largest remainder, with ties broken by line ID.
Discounts remain negative. Excess over the invoice amount is **Unapplied**.
Current billing transitions require an exact invoice amount; the report also
handles excess receipts already present in storage.
Billing transitions mark unaccepted duplicate card receipts with
`accepted: false` in the payment audit event: their entire received amount is
Unapplied until a successful refund reverses it. Older payments without that
explicit marker are treated as accepted, matching billing transitions. An empty
or zero-amount invoice also leaves its receipt Unapplied. Refunds are allocated
over their own payment's allocated parts, including discounts and Unapplied,
with the same exact integer rule. Each refund is allocated independently.

`plan` groups membership lines by the plan each line recorded when it was billed
(`invoice_line_items.plan_id`); `signup_fee` is a separate group for that plan.
A plan change on the membership leaves those lines where they are. Lines written
before migration `0029` recorded no plan, so they fall back to the membership's
**current** plan, and a plan change still moves them. `charge_type`
groups typed charges; `other` covers untyped charges. `discount`, each `tax`, and
`unapplied` are separate groups. Archived plans, charge types and taxes retain
their current names. Built-in groups have null IDs/names for client localization;
tax lines without a tax ID retain their description. Tax allocations are shown
apart: monthly `netBeforeTax + netTax = net`. Every group's `payments - refunds =
net`, including signed discount refunds; groups add exactly to monthly totals.

`revenue.allocation.ts` uses BigInt products and signed floor/remainder arithmetic
internally, returning safe integer minor units. `createRevenueReportService`
reuses the shared local-month boundaries. `revenue.query.ts` performs four
statements in one short `forGym` call: received payments, resolved refunds with
their payments, touched invoice lines joined to current catalog names, and
payment acceptance audit markers. No statement is added per invoice or month.
The report only reads billing data and requires no extra runtime configuration.

## Timing and indexes

`timing.test.ts` loads two synthetic gyms through app-role bulk inserts. Each has
300 households and members, 300 memberships, 3,450 cycle invoices and payments,
6,900 invoice lines, 165 refunds, 3,870 audit events and 44,490 check-ins across
155 classes in 2025. The fixture includes imports, cancellations, a June freeze
with a July resume, and December freezes. It schedules about three visits a week
per active, unfrozen member. The gyms use USD and JPY respectively: the schema
enforces one billing currency per gym.

Each report runs over December alone, all twelve months of 2025, and January
2024 through December 2025 (24 months, including an empty preceding year), with
the equally sized second gym present. Tests assert 1 attendance, 1 members and
4 revenue statements, plus BEGIN, gym context and COMMIT, and a generous **15 s**
bound per service call. They compare each 24-month result before and after adding
the second gym and check the underlying readers' rows, IDs and known totals.
Every measured query and EXPLAIN uses the app role and forced RLS.

One warm-cache workstation run on PostgreSQL 18.6 and Node 24.22.1 measured these
whole-service times in milliseconds, before and after migration `0028`:

| Report | Months | Before | After |
| --- | ---: | ---: | ---: |
| Attendance | 1 | 11.43 | 14.45 |
| Attendance | 12 | 92.58 | 114.14 |
| Attendance | 24 | 118.75 | 162.43 |
| Members | 1 | 7.18 | 15.24 |
| Members | 12 | 7.40 | 20.32 |
| Members | 24 | 7.52 | 9.83 |
| Revenue | 1 | 20.95 | 20.26 |
| Revenue | 12 | 109.13 | 197.13 |
| Revenue | 24 | 140.64 | 182.86 |

These are individual observations on a shared machine, not performance targets.
Timing includes validation, bucket generation, transaction, query transfer and
aggregation; connection initialization, fixture construction, warming and EXPLAIN
replays are outside the timer. Broad ranges need every fixture row for that gym;
the planner keeps their existing scans, so the time indexes do not promise to
speed up full-history reports. Members needs the complete lifecycle history and
gets no new index.

The extra one-month probe justifies the three new `(gym_id, time)` B-tree indexes:

- Attendance's old `(gym_id, member_id, occurred_at)` bitmap index scan touches
  755 shared buffers for 3,360 visits. `attendances_gym_occurred_at_idx` touches 4;
  its heap scan touches 66 buffers instead of 817.
- Payments previously select all 3,450 gym receipts, then filter out 3,210.
  `payments_gym_paid_at_idx` selects 240 directly; heap buffers fall from 54 to 7.
- Refunds previously scan 330 rows across both gyms and filter out 315.
  `refunds_gym_resolved_at_idx` selects 15 directly; heap buffers fall from 6 to 2.

The migration adds only those indexes. It changes no columns, rows or RLS rules.
The upgrade test starts at the secured, populated `0027` schema and verifies the
index definitions, existing rows and isolation after migration.

Run `pnpm exec vitest run apps/server/src/areas/reports/timing.test.ts` to repeat.
Set `REPORT_TIMING_ARTIFACT` to a writable file path to retain full captured
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` plans and timings. For a baseline run,
also set `REPORT_TIMING_WITHOUT_TIME_INDEXES=1`: it removes only these three
indexes from this test file's disposable clone, leaving the migrated template
unchanged. Unset it for the indexed comparison. Plan replays use the original
driver SQL and bind parameters in a fresh transaction scoped to the same gym.

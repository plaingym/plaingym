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

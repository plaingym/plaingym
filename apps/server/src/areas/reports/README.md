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

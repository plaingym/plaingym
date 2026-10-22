<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Attendance

`createAttendanceService({ scope, householdScope, clock })` exposes append-only recording,
staff history and totals, and the frozen `AttendanceQueries` implementation. The default
scopes are `forGym` and `forHousehold`. `createAttendanceQueries(options)` exports just
the read interface for promotion criteria and other consumers.

Session check-ins lock the session row and use the existing unique member/session
constraint. Replays return the original entry without another audit event. Cancelled
sessions reject new check-ins; existing attendance remains readable. Imports may supply
a trusted source key, which is unique within the gym. HTTP forms always record `coach`
as the source. Kiosk callers pass a device audit actor and `kiosk` source directly to
the service after device authorization.

Open-mat visits have no session. Each submission creates a separate visit, even at the
same instant. Clients must not automatically retry these writes. Imported open-mat
visits can be retried safely using a source key.

Program filters include the attendance's direct program and the materialized session's
program links. Tags come only from materialized session links. A visit counts once in
the total and once per distinct program/tag, even when its direct program also appears
on the session. Template edits cannot reclassify attendance. Intervals include `since`
and exclude `until`; history sorts newest first, then ID ascending.

Household activity is read only with `forHousehold`, reloading grants on every call.
The frozen household query facade returns authorized activity without filters or
pagination, so those are applied after retrieval. When needed, a separate short gym
scope loads only session program/tag metadata referenced by those authorized rows.
It never loads household activity. Adult members see only themselves; payers see their
household. A missing or revoked grant returns not found.

The prewired attendance route barrel imports `attendance.routes.ts`. The web contribution
registers the coach roster under `sessionPanels` and the totals/open-mat panel under
`memberTabs`. Member/program/tag APIs are consumed through their shared contracts; the
corresponding implementations must be present for the panels to load. Tests use fixture
sessions, independent of the schedule materializer.

`pnpm test` runs the UI/client checks and the service, authorization, concurrency,
audit, and real-interface comparison tests against disposable PostgreSQL.

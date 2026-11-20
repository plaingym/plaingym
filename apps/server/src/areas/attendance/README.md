<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Attendance

`createAttendanceService({ scope, householdScope, clock })` exposes recording and staff undo,
staff history and totals, and the frozen `AttendanceQueries` implementation. The default
scopes are `forGym` and `forHousehold`. `createAttendanceQueries(options)` exports just
the read interface for promotion criteria and other consumers.

Session check-ins lock the session row and use the existing unique member/session
constraint. Replays return the original entry without another audit event. Cancelled
sessions reject new check-ins; existing attendance remains readable. Imports may supply
a trusted source key, which is unique within the gym. HTTP forms always record `coach`
as the source. Kiosk callers pass a device audit actor and `kiosk` source directly to
the service after device authorization.

Every live check-in (kiosk/PIN, QR, or staff; class or open mat) locks the member
before drawing one class credit, earliest expiry first. An `active` or `trial`
membership covers the visit without spending credits; a frozen membership does
not. Imports never spend. Session replays return before drawing, and a partial
unique ledger index allows one use per attendance. Staff can record a visit with
no usable credits; a new staff record response then includes `needsCredits: true`,
and the roster or open-mat form displays a notice. Staff retries preserve the
notice from the recording audit's `after.needsCredits === true`, even if credits
have since been bought. This is a historical notice, not a fresh balance check:
an absent or redacted recording audit, or one written without that flag (such as
an import), cannot reproduce it and returns no notice. This dependency affects
only the staff response; attendance deduplication and credit spending do not
depend on the audit row. This flag is absent from kiosk responses.
`attendance.recorded.after.creditSpent` states whether a live
visit spent a credit. A kiosk pack holder with no usable credits and no active
membership is refused atomically, with only `see_front_desk` reaching the shared
screen. A member who has never held credits checks in as before.

Backdated staff visits are corrections made today: membership cover and credit
usability use the recording clock, even when `occurredAt` is earlier.

A live open-mat visit (no session, from the kiosk, QR or staff) counts once per
member per gym-local day of its `occurredAt`: under the member lock, a second one
that day returns the first visit, as a session replay does, without a new row,
audit or credit. A second tap, a retry after a lost response, or a kiosk visit
after a staff one therefore spends one credit. Imports are never deduplicated
this way.

POST `/api/attendance/{id}/undo` requires `attendance.manage` (all staff roles).
It locks the member then the attendance row, deletes a live `coach` or `kiosk`
visit, and returns any spent credit to its original lot with a `reverse` entry
(`returnCredit` in `billing/packs/ledger.ts`), unless that lot's pack was refunded
in full since, when the credit stays spent. The lot keeps its expiry.
`attendance.undone` audits the full deleted row in the same transaction, with
`after.creditReturned` when the visit had spent a credit. A repeated or cross-gym undo is 404; an import is 409
and cannot be undone. Attendance is therefore no longer append-only for live
visits; the credit ledger remains append-only. Undo does not rewind lead stages.
The session roster offers a confirmed Undo action on live checked-in rows and
refreshes session counts after success; imported rows have no Undo action.

After a new non-import visit and its audit are inserted, the same transaction
advances an eligible lead to `trial_attended`, preserving its first attendance
time and auditing the caller's actor. Repeated visits leave an already advanced
lead unchanged; won and lost leads keep their stages. A prospect or trial member
without a lead gains a null-source lead; other members without one gain none.

Each attendance stores a kind, `class` or `open_mat`, fixed when it is recorded: a
session check-in copies the session's kind, and a kiosk or coach visit without a
session is open mat. Imports without a session default to `class` and may pass
`open_mat`. Later session edits never reclassify recorded attendance.

Open mat is a visit, not a class. Unscheduled live open-mat visits have no session
and deduplicate within the gym-local day as described above. Imported visits can be retried safely using a
source key. The `classesOnly` filter (used by the classes-since-promotion criterion)
and the `classes` total leave open mat out unless the gym's
`openMatCountsAsClass` setting is on (it is off by default). `total` and the
per-program and per-tag counts include every visit.

Program filters include the attendance's direct program and the materialized session's
program links. Tags come only from materialized session links. A visit counts once in
the total and once per distinct program/tag, even when its direct program also appears
on the session. Template edits cannot reclassify attendance. Intervals include `since`
and exclude `until`; history sorts newest first, then ID ascending.

`promotion.query.ts` batches promotion windows in one scoped statement, using
`attendance.ts`'s `predicate` for program links, open-mat inclusion, and the
exclusive `until`. For each program, it compares the number of distinct
candidates with the number of distinct members who visited from the earliest
candidate window, including former and inactive members. The probe stops as
soon as enough visitors put the candidate share below 75%.
At 75% or more it scans the program once and joins the filtered rows to the
candidate windows. Below 75% it joins each candidate window to an indexed
attendance count for that member. Both paths use each candidate's own inclusive
`since`. Direct and session links count a visit once within a window, and only
a matched candidate member's visits affect a count.

Household activity is read only with `forHousehold`, reloading grants on every call.
Its `attendancePage` and `attendanceCount` queries filter, order, page and count in
SQL, with the gym path's program, tag and open-mat matching, and read session
program and tag links only to apply those filters. Adult members see only themselves;
payers see their household. A missing or revoked grant returns not found.

The prewired attendance route barrel imports `attendance.routes.ts`. The web contribution
registers the coach roster under `sessionPanels` and the totals/open-mat panel under
`memberTabs`. Member/program/tag APIs are consumed through their shared contracts; the
corresponding implementations must be present for the panels to load. Tests use fixture
sessions, independent of the schedule materializer.

`pnpm test` runs the UI/client checks and the service, authorization, concurrency,
audit, and real-interface comparison tests against disposable PostgreSQL.

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
and cannot be undone. Live attendance can be deleted through undo. The credit
ledger remains append-only. When the undone visit set a `trial_attended` lead's
trial time, undo moves the time to the earliest remaining non-import visit and
audits the correction in the same transaction. With no such visit, it keeps
the time. Undo preserves the lead's stage.
The session roster offers a confirmed Undo action on live checked-in rows and
refreshes session counts after success; imported rows have no Undo action.

After a new non-import visit and its audit are inserted, the same transaction
advances an eligible lead to `trial_attended` with the visit's occurrence time
and audits the caller's actor. A backdated visit earlier than the stored trial
time moves it back and audits the correction. Won and lost leads keep their
stages. A prospect or trial member without a lead gains a null-source lead.

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
soon as enough visitors put the candidate share below 75%. When the gym has more
than four members per allowed visitor, the statement skips the probe and uses
the per-candidate read.
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
`memberTabs`.

The coach check-in roster lists the session's people, not the whole gym: it reads
the bookings session roster with `checkInEligible=true` (see the bookings README),
so it shows booked members, then waitlisted members with a `Waitlisted · #<rank>`
badge for their current place in line, then walk-ins already checked in, and never
erased or Cancelled members. Checking in a waitlisted member records attendance
only; their booking and place stay as they are. **Check in someone else** is one
member autocomplete over the eligible member list (`checkInEligible=true` on
`GET /api/members`); choosing a member records their check-in, and they then appear
as a walk-in until the check-in is undone. The roster reloads after every check-in
and undo. It also follows each successful read by the session dialog's bookings
panel (after a booking or cancellation in that panel, a promotion after a capacity
change, a check-in reported to the dialog, and that panel's periodic, focus and
visibility reloads) with one quiet read of its own page, and shows the new page when
its participants changed: who is on it, their booking's ID, status and place, and
their check-in. A replacement booking or a kiosk walk-in therefore appears even when
every count stays the same. A failed bookings read is not followed, and the roster's
own reads trigger nothing further.

A walk-in's confirmation, and the credit warning a check-in may carry, belong to
the attendance that check-in recorded, not to the member. While the roster page
lists that attendance the confirmation says the member is checked in; once a later
read of that page no longer lists it (undone on another device, for example), the
confirmation and its warning disappear, and a new visit for the same member shows
only its own feedback. A walk-in that isn't on the page being shown gets a
past-tense acknowledgment instead, "Recorded a walk-in for <name> at <time>.", with
its credit warning, which later reads leave in place. Member/program/tag APIs are consumed through their shared contracts; the
corresponding implementations must be present for the panels to load. Tests use fixture
sessions, independent of the schedule materializer.

`pnpm test` runs the UI/client checks and the service, authorization, concurrency,
audit, and real-interface comparison tests against disposable PostgreSQL.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Schedule

Weekly templates use Sunday = 0 and a local wall-clock start time. The
`schedule.materialize` job runs at midnight in each gym's IANA timezone and
creates occurrences for today through the next 55 calendar dates. Creating or
updating a template materializes that template in the same transaction, so its
upcoming sessions exist right away rather than after the next nightly run. It skips
nonexistent DST times and chooses the earlier instant when a time repeats.
Duration is elapsed minutes, including when a session crosses a DST transition.

Materialization locks one template per short transaction. Each generated
session stores its occurrence key (`occurrence_starts_at`): the start its
template originally scheduled, which never changes afterwards. One-off sessions
have none; sessions detached by deleting their template keep theirs. The unique `(gym_id, template_id, occurrence_starts_at)` constraint
protects retries, and an occurrence's local date counts as generated whatever
its session's current start, so existing local dates are preserved when a
template's start time changes. Program and tag mappings and the kind (`class` or
`open_mat`) are copied to sessions;
subsequent template edits affect only dates that have not been materialized.
Cancellation, coach swaps, notes and capacity overrides survive retries.
The kind defaults to `class` on create; full-replacement updates must restate it.

A generated session can be moved with the full session update (revision-checked
and audited): its ID, bookings, attendance and occurrence key stay, and
materialization never recreates it at its original time. Sessions generated
without a key (by the previous release) are treated as never moved: their start
is their occurrence, and the first move stores it as their key.
The earlier `(gym_id, template_id, starts_at)` constraint is kept while the
previous release may still run against this schema, so a session can't be moved
onto the exact start of another session of the same template (409 `session_start_taken`), and an
occurrence whose start a moved session already holds is not generated.
There is no hard-delete session endpoint. Deleting a template detaches its
sessions with revision increments and audits, retaining attendance and mappings.
Referenced tags cannot be deleted.

The local `GET /api/schedule/options` response projects the gym timezone and
program/coach IDs and names for schedule readers (TODO: move the response into the shared contract).
All other endpoints use the shared schedule contracts. The cancel request accepts
optional `notify: true` and a plain text `note` of at most 1,000 characters.
With notification requested, the service checks the current user's stored roles
and linked staff profile under the session row lock: only an owner, admin or
that session's assigned coach may proceed. A refusal rolls back the entire
cancellation. Without notification, the existing cancellation permission applies.
The cancellation, audit and notice job commit together. The payload snapshots only
that session's booked and waitlisted member IDs and the note; bookings themselves
are unchanged. Repeated cancellation does not queue another notice.

The session dialog offers an unchecked email option with the booked-plus-waitlisted
count when fresh panel counts are available and the actor may notify. Selecting it
reveals the optional note. A failed roster refresh keeps a selected option and
note, and waits for fresh counts before sending. Coach visibility compares the bootstrap's gym-scoped
`staffProfileId` with the session's `coachId`; API authorization is independent.

The existing area route/job barrels load `schedule.routes.ts` and
`schedule.jobs.ts`. Notification delivery requires the announcements area's
`configureCancellationNotice` runtime setup (see its README); ordinary cancellation
does not. The admin calendar
renders enabled, permitted `sessionPanels` contributions without importing
their components directly. A panel can publish booking counts for the session
dialog's summary (`lib/session-summary.tsx`); the dialog shows them beside the
capacity when a panel has published any. The dialog also tells its panels when a
capacity change may have moved bookings (cancelling a session leaves its
bookings as they are), and a panel can tell
the dialog about its own changes (a check-in), so a panel that shows counts reloads.

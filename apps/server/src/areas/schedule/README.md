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
subsequent template edits affect only dates that have not been materialized,
except a capacity change, which also updates the template's upcoming scheduled
and cancelled sessions that still have its previous capacity (one
`schedule.session.capacity` audit each, with booking reconciliation for scheduled
sessions and none for cancelled ones). Restoring such a cancelled session books
up to the new capacity: after a lowered one, former bookings over it join the
waitlist. A session whose capacity differs from the previous one keeps it; one
set by hand to that same value can't be told apart and changes too. The whole
template save is refused when one of those scheduled sessions has more booked
members than the new capacity. The refusal names one blocking session's start
(`details.startsAt`; of several, the first by session ID, not necessarily the
earliest), which the editor shows in the gym's timezone.
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
All other endpoints use the shared schedule contracts. Every session response includes a read-only `cancelBefore`
instant, derived from the gym's current cancellation cutoff using the booking
rules, read once per transaction. Audit snapshots contain stored session fields
and mappings only; they exclude this derived cutoff. Create and update requests cannot set it. The cancel request accepts
optional `notify: true`, `channels` (`["email"]`, `["sms"]` or both, each at most once) and a plain text `note` of
at most 1,000 characters. `notify: true` without `channels` sends both channels. `channels` without `notify: true`
is a 400 `invalid_request` with reason `channels_without_notify`, before any write.
Once its start time is reached, a session cannot be cancelled, with or without a
notice. The service checks the injected clock after acquiring the session row
lock and returns a conflict with reason `session_started` before any writes.
The session dialog hides cancellation controls for started sessions and shows
the specific refusal if the session starts while a request is in flight, then
hides the controls for that start time even if the browser clock is behind; a
session moved since then offers them again. A single timer targets the start
time and stays armed when the window regains focus or the page becomes visible
before the start. At or after the start, the timer and those events update the
dialog and tell a user who could cancel why the controls went away. Both
messages say the cancellation note was not sent only when one was being written.
If another caller already cancelled it, the dialog shows that no cancellation
notice was queued and refreshes the session instead of showing a generic conflict.
With notification requested, the service checks the current user's stored roles
and linked staff profile under the session row lock: only an owner, admin or
that session's assigned coach may proceed. A refusal rolls back the entire
cancellation. Without notification, the existing cancellation permission applies.
The cancellation, audit and notice job commit together. The payload snapshots only
that session's booked and waitlisted member IDs, the note and the chosen channels before cancelling
those bookings, setting their cancellation time, clearing queue positions and
writing one `booking.cancelled` audit per booking. Each booking it cancels also keeps a marker:
`session_cancel_status` (`booked` or `waitlisted`) and, for a waitlisted one, its old position in
`session_cancel_position`. Every repeated cancellation returns a conflict
without changing the revision or queuing another notice. A cancellation after a restore adds the
session's restore count to its notice (`round`), so it gets its own notice (see the announcements README).

`POST /api/schedule/sessions/{id}/restore` (`schedule.manage`) brings a cancelled session that hasn't
started back to `scheduled`, increments its internal `restore_count` (not in the response), and
carries `restoredBookings` (the count of bookings brought back, booked or waitlisted; waitlist
promotions afterward don't count). It takes the revision, optional `notify: true` and optional
`channels`, with the same rules as cancelling, and no note. Under the session row lock it brings
back only the bookings the session's cancellation cancelled (those with a marker): first the ones
that were booked, in booking order, each booked while the capacity allows (always when there is
none) and otherwise waitlisted; then the old waitlist in its order. Waitlisted places take the
session's highest position plus one. Each restored booking clears its cancellation time and marker
and gets one `booking.restored` audit. A booking its member cancelled before the session was
cancelled stays cancelled, as does a marked booking of a member erased while the class was
cancelled or who already holds another place in the session; its marker is cleared too, so a
cancellation's bookings come back at most once. A session cancelled before the release that marks
cancelled bookings has no markers, so it restores to `scheduled` with no bookings back, queues no
notice, and reports `restoredBookings: 0` so members book again. A member whose membership changed
meanwhile comes back like anyone else; only promotion from the waitlist checks eligibility, as
always. A free place then promotes the waitlist as a capacity change does, with its
`booking.promoted` audits and promotion notices. The session gets a `schedule.session.restored`
audit with both snapshots. Refusals change nothing: a session that isn't cancelled is a 409
`conflict` with reason `not_cancelled`, one whose start time has been reached a 409 with reason
`session_started`, and a stale revision the usual revision conflict. With notification, the same
rule as cancelling applies (an owner, an admin or the session's coach), checked by the same helper;
any coach may restore without it. When at least one booking came back, the "back on" notice job for
those members commits with the restore.

The session dialog offers two unchecked options, Email and Text, each with the
booked-plus-waitlisted count, when fresh panel counts are available and the actor may
notify. Staff can tick either or both; no text is sent unless Text is ticked. A hint under
Text says texts go to each member's own phone when they agreed to notices texts, otherwise to
their household's billing phone when it agreed to them, and only while Member
texts is on in Settings → Go-live. With nobody booked or waitlisted, both are locked.
Ticking Email reveals the optional note, which appears in email only. The request sends `notify: true` with the
ticked `channels`; with neither ticked it sends neither field, and without Email it sends no `note`. A failed roster refresh
keeps the selected options and note, and waits for fresh counts before sending. Unticking Email hides the note
box but keeps its text for when Email is ticked again; a saved cancellation empties it.
Each notice lists the booked or waitlisted members its destination covers, except when
one member receives it at their own email or consented phone. A household fallback
lists the members it covers even when only one is booked or waitlisted.
Coach visibility compares the bootstrap's gym-scoped
`staffProfileId` with the session's `coachId`; API authorization is independent.

For a cancelled session that hasn't started, a user with `schedule.manage` sees the restore form
where the cancel form is: a paragraph on what restoring brings back, then, for a user who may notify,
two unticked boxes (email and text the members whose places come back, the text box with the same
hint), and a **Restore class** button. It posts the revision, plus `notify: true` and the ticked
channels when either box is ticked. On success the dialog says the class is restored—and, when
`restoredBookings` is 0, that no places came back (adding that no notice was sent when a box was
ticked)—and its panels reload. A `session_started` refusal says the session can no longer be restored and hides the form; a
`not_cancelled` one says no notice was queued and refreshes the session. A started cancelled session
shows no restore form; a user with `schedule.manage` sees that it has started and can't be restored.

The existing area route/job barrels load `schedule.routes.ts` and
`schedule.jobs.ts`. Notification delivery uses the announcements area's
cancellation and restore notices, which the runtime configures (see its README); ordinary
cancellation and restoring without a notice don't need them. The admin calendar
renders enabled, permitted `sessionPanels` contributions without importing
their components directly. A panel can publish booking counts for the session
dialog's summary (`lib/session-summary.tsx`); the dialog shows them beside the
capacity when a panel has published any, and hands them to the other panels, so the
coach check-in roster can follow booking changes. The dialog also tells its panels when a
capacity change, session cancellation or restore may have changed bookings, and a panel can tell
the dialog about its own changes (a check-in), so a panel that shows counts reloads.

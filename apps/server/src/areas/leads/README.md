<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Lead intake

`recordLeadIntake(tx, { gymId, memberId, source, now })` creates the member's
one-to-one lead and a `lead.created` system audit containing only its source.
Call it inside the intake's existing `forGym` transaction, with time from the
injected clock. Concurrent or later retries keep the first source and create
no second row or audit.

The public trial form records `trial_form`; drop-in admission records `drop_in`
and the visitor step preserves that row. Join submission records `join` for
each admitted member in the transaction that locks the household and marks
submission. Join admission itself creates no lead, allowing existing cleanup
to remove unsubmitted admissions.

`leads` holds source, stage, follow-up date, lifecycle timestamps, lost reason
and revision. `lead_contacts` holds the staff contact history. Both tables have
forced gym RLS and composite gym references and are included in gym exports.
`leads.manage` is granted to owners, admins and front desk, excluding coaches.
No job deletes or erases leads, and migration does not backfill existing members.

## Automatic stages

`advanceLeadOnCheckIn` runs after a new non-import attendance and its audit are
inserted. It advances `new`, `contacted` and `trial_booked` to `trial_attended`,
preserving the first `trial_attended_at`. Won and lost leads keep their stage.
Staff, session and kiosk check-ins share this path.

`markLeadWon` runs when a pending or trial membership activates (including a
paid invoice's activation effect), or an assignment starts active. It advances
any stage except `won`, including `lost`. Trial assignments and frozen resumes
do not call it. Imports insert their rows directly and change no stage.

Both helpers take the caller's gym transaction, actor and clock time. A missing
lead is created with a null source only for a prospect or trial member; other
members with no lead are harmless no-ops. They lock the lead before changing it,
bump its revision and write a `lead.stage_changed` audit with the caller's actor,
without copying contact details or lost reasons. Repeats change and audit nothing.
Creation acquires a member key-share lock before inserting the unique lead key
to preserve the lock order of a racing check-in.

## Funnel counts

`GET /api/leads/funnel?from=YYYY-MM-DD&to=YYYY-MM-DD` requires `leads.manage`
and returns `Cache-Control: no-store`. Dates are inclusive in the gym's timezone,
ordered and limited to 24 calendar months. Instants come only from shared time
helpers, so midnight and daylight-saving boundaries follow the gym's zone.

The cohort uses the member's creation date. Persisted leads are counted even
after member erasure; prospects and trial members without lead rows count as
unknown open leads. Ordinary members without lead rows are excluded. Each
source present in the cohort has `leads`, `trialAttended` (a recorded first
attendance timestamp), `won`, `lost` and `open` counts. Won, lost and open use
the current stage; null source is `unknown`. There are no member details in the
response. An empty cohort returns an empty sources array. The reviewed
`funnel.query.ts` performs one aggregate statement in one `forGym` transaction,
independent of date range or cohort size.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Leads

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

## Staff list and edits

All five routes below require `leads.manage` and return `Cache-Control: no-store`:

* `GET /api/leads` lists identifiable members with a lead row, plus prospects and
  trial members without a row. Row-less leads show stage `new`, null source and
  revision 0. Items contain member and household IDs, name, email, phone, member
  status, source, stage, follow-up date, last contact time and member creation time.
* `GET /api/leads/{memberId}` reads the same fields plus the lost reason. A missing,
  erased, foreign-gym or ordinary non-lead member returns 404.
* `PATCH /api/leads/{memberId}` accepts `revision` and one or more of `source`
  (nullable), `stage` and `nextFollowUpOn` (nullable gym-local date).
* `POST /api/leads/{memberId}/lost` accepts `revision` and a trimmed reason of
  1–500 characters. It keeps the lead and records its lost time.
* `POST /api/leads/{memberId}/reopen` accepts `revision`, moves a lost lead to
  `contacted`, and clears the reason and lost time.

The list accepts repeatable `stage`, `includeLost=true|false`, a known `source`
or `source=unknown`, `due=true|false`, literal case-insensitive name `search`,
`limit` (default 50, maximum 100) and `offset` (default 0). With no explicit stage,
lost leads are hidden unless `includeLost=true`; an explicit stage takes precedence.
Due means an open stage with follow-up on or before today in the gym's timezone;
won and lost leads never count as due. Results sort by last name, first name and
member ID. `counts` contains all six stage totals for the same filters, before
paging; `pagination.total` is their sum. The list performs two query-builder
statements in one gym scope, regardless of page size or cohort size.

Staff can set `new`, `contacted`, `trial_booked` and `trial_attended`; manually
recording attendance preserves or sets the first trial-attended time. Only
automatic membership activation sets `won`, and only the lost route sets `lost`.
A won lead cannot change stage or be marked lost. A lost lead must be reopened
before a manual stage change. Source and follow-up remain editable on either.
Invalid stage transitions and stale revisions return 409. A row-less lead's first
edit inserts revision 1; competing inserts also return 409. Edits lock against
member erasure and use the existing revision guard on persisted rows.

Mutations write `lead.updated`, `lead.lost` or `lead.reopened` in the same
transaction, with stage, source, follow-up and revision only; lost reasons are
never copied into audits. Member erasure removes contact rows and clears the
lost reason while retaining the lead for aggregate history. Erased members do
not appear in the staff list or read.

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

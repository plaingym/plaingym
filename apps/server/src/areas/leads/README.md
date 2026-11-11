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

## Contact log

Both contact routes require `leads.manage` and return `Cache-Control: no-store`,
and reach the same leads as `GET /api/leads/{memberId}` (others are 404):

* `POST /api/leads/{memberId}/contacts` accepts the lead's `revision`, a `channel`
  (`call`, `text`, `email`, `in_person` or `other`), an optional trimmed `note`
  of up to 2,000 characters (counted in code points, as the database does; blank
  is stored as none) and an optional `nextFollowUpOn` (a gym-local date, or null
  to clear it). It records the contact now with the signed-in staff user, sets
  `last_contacted_at`, moves a `new` lead to `contacted` (later stages, won and
  lost keep theirs), sets the follow-up when one is sent and bumps the revision.
  A prospect or trial member without a lead row gains one at revision 1, as a
  first edit does. A stale revision or a racing first insert returns 409 and
  writes nothing. It returns the updated lead and the contact. The request body
  may be up to 32 KiB, room for a 2,000-character note even when a client
  escapes every non-ASCII character as `\uXXXX`.
* `GET /api/leads/{memberId}/contacts` lists contacts newest first with `limit`
  (default 50, maximum 100), `offset` and a total. Each has its time, channel,
  note, the staff user's ID and their staff profile's display name (null without
  a profile). A lead without a row has none.

The contact, the lead change and a `lead.contacted` audit commit together. The
audit holds the stage, follow-up and revision before and after, the channel and
the contact ID, never the note. The member is locked before the lead, as edits
do, so erasure waits; erasure then deletes the contacts and both routes return 404.

## Follow-ups due tile

`createFollowUpsDueProvider({ settings })` in `areas/dashboard/leads.ts` is the
dashboard extension widget `leads.follow-ups-due` (kind `count`, permission
`leads.manage`). It counts open leads (not won or lost, member not erased) whose
follow-up date is on or before today in the gym's timezone, and lists the
soonest 20 (then by name), each linking to `/admin/leads/<memberId>`. With none
due it returns null and the dashboard omits it. After reading the gym's timezone
from the settings, it counts and lists in one statement.

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

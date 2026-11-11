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

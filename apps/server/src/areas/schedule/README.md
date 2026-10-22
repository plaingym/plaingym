<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Schedule

Weekly templates use Sunday = 0 and a local wall-clock start time. The
`schedule.materialize` job runs at midnight in each gym's IANA timezone and
creates occurrences for today through the next 55 calendar dates. It skips
nonexistent DST times and chooses the earlier instant when a time repeats.
Duration is elapsed minutes, including when a session crosses a DST transition.

Materialization locks one template per short transaction. The unique occurrence
constraint protects retries, and existing local dates are preserved when a
template's start time changes. Program and tag mappings are copied to sessions;
subsequent template edits affect only dates that have not been materialized.
Cancellation, coach swaps, notes and capacity overrides survive retries.

Generated start times cannot be moved while the template is attached. An
immutable occurrence key is needed to support that operation safely
(`TODO(CCR)`). Cancel the occurrence and create a one-off replacement instead.
There is no hard-delete session endpoint. Deleting a template detaches its
sessions with revision increments and audits, retaining attendance and mappings.
Referenced tags cannot be deleted.

The local `GET /api/schedule/options` response projects the gym timezone and
program/coach IDs and names for schedule readers (`TODO(CCR)`: shared contract).
All other endpoints use the frozen schedule contracts.

The existing area route/job barrels load `schedule.routes.ts` and
`schedule.jobs.ts`. No extra runtime wiring is required. The admin calendar
renders enabled, permitted `sessionPanels` contributions without importing
their components directly.

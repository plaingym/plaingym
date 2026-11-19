<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Ranks and promotions

`configureRanks({ attendance, clock, providers })` connects the pre-registered HTTP
routes to an `AttendanceQueries` implementation and optional criterion providers.
It returns the criterion registry, which also supports explicit registration.
Until configured, the routes return 503. Tests inject their own scoped service
through `createRanksRoutes(() => service)`.

The core providers are `classes-since-promotion`, `time-at-rank` (elapsed whole
days), and `minimum-age` (completed birthdays). Each takes `{ target: number }`,
where the target is a nonnegative integer. Other providers supply their own
configuration schema and progress measurement through `PromotionCriterionProvider`.
Providers with a `moduleId` participate only when that module is enabled for the
gym. Missing or disabled providers fail closed. Evaluation happens after the
database snapshot transaction closes, so a provider can safely call other services.

Stored sub-ranks and criterion entries strip unknown keys before projection or
evaluation; create and update requests remain strict. An update that sends them
replaces them in full. The rank editor sends only changed fields, keeping stored
extensions on unrelated edits. Rank update audits use the stored row for both
before and after, while responses still strip unknown entry keys. Provider configuration is
still validated by its provider: a compatible minor cannot add configuration keys
or provider IDs that the previous minor cannot evaluate (`docs/versioning.md`).
Closing or cancelling an edited rank asks before discarding any changed field,
including its name, position, color, sub-ranks and criterion targets.

Eligibility uses active, non-anonymized members. Attendance and elapsed time start
at the most recent promotion in the selected program, or the member's creation
time before their first promotion. Each sub-rank promotion resets those counters.
Staff may record a coach's promotion decision independently of eligibility targets.
History records both the rank and program's shared rank system.

`progression.ts` holds the one rank-system ordering every reader uses: the latest
promotion (`promotionOrder`: promotion time, then rank position, sub-rank, creation
time and ID), whether a member can still receive a rank (`canReceive`), the sub-rank
it would award (`nextSubRank`) and the next step (`nextPromotion`, the current rank's
next sub-rank first). Eligibility, the promotion check, the promotion list and
`memberProgress` all sort promotions in application code with `promotionOrder`; none
orders them in SQL. The promotion check reads the member's history in that program
after locking the member row, then sorts it.

Eligibility uses `nextPromotion` for its requested rank; member progress and the
dashboard use it across the program's ranks, including when no previous rank
exists. The dashboard reads latest promotions with `DISTINCT ON`, ordered by the
same date, position, sub-rank, creation and ID rules, joining the active roster
instead of binding every member ID. It consumes those rows without sorting again.
Its criterion registry supports an optional local `prepareBatch` provider hook;
providers without a hook retain their normal evaluator and all validation. A
batch read must use the gym attendance scope and the same `until` as every
context's clock; `prepareBatch` refuses any other context before a provider runs.
The classes provider batches through the shared attendance predicate in
`attendance/promotion.query.ts`, rather than a dashboard-specific counting rule.
Ready-only eligibility builds one batch for all its candidates before filtering
and paginating, so it reads the same class counts as the dashboard.

`memberProgress` applies the ordering to one member's history, supplied by the caller
from its own scope. It returns each program's current rank, the next step and the
history from that same ordering, so they can't disagree, and evaluates the next step's
criteria in the caller's attendance scope. Inactive programs and the top rank have no
next step. It covers the programs the member holds a rank in, then the programs the caller
says they attended (`attendedProgramIds`) that are active and have ranks: for those the
next step is the first rank, with its criteria counted from the member's `createdAt`, as
eligibility counts them for a member with no history.

Every promotion locks its member and checks the current history in the same
transaction as the history row and audit. Bulk requests preflight gym references
and then commit one member at a time. If a later member fails, earlier promotions
remain saved; reload history before retrying. Duplicate or backward promotions
are rejected, including concurrent requests.

Rank edits use revisions. Content packs seed missing records and preserve the
gym's names, colors, order, sub-ranks, and criteria when reapplied.

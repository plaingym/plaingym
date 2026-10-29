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

`memberProgress` applies the ordering to one member's history, supplied by the caller
from its own scope. It returns each program's current rank, the next step and the
history from that same ordering, so they can't disagree, and evaluates the next step's
criteria in the caller's attendance scope. Inactive programs and the top rank have no
next step. It covers the programs the member already holds a rank in.

Every promotion locks its member and checks the current history in the same
transaction as the history row and audit. Bulk requests preflight gym references
and then commit one member at a time. If a later member fails, earlier promotions
remain saved; reload history before retrying. Duplicate or backward promotions
are rejected, including concurrent requests.

Rank edits use revisions. Content packs seed missing records and preserve the
gym's names, colors, order, sub-ranks, and criteria when reapplied.

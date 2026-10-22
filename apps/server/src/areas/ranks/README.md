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

Every promotion locks its member and checks the current history in the same
transaction as the history row and audit. Bulk requests preflight gym references
and then commit one member at a time. If a later member fails, earlier promotions
remain saved; reload history before retrying. Duplicate or backward promotions
are rejected, including concurrent requests.

Rank edits use revisions. Content packs seed missing records and preserve the
gym's names, colors, order, sub-ranks, and criteria when reapplied.

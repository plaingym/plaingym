<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Membership CSV mapper

`membershipsMapper` imports active renewals through the default CSV pipeline.
The existing upload, preview, start, progress and errors routes and pipeline job
need no extra registration. Runs and chunks are recorded in `import_runs` and
`import_chunks` in the same transaction as domain writes.

Import people first and create the plans in the catalog. Each row needs an email
or both names, an existing plan's name or UUID, and `nextDueOn` as a real
`YYYY-MM-DD` date. All supplied identity fields (including optional birth date)
must match exactly after case/spacing normalization. Shared emails need names or
a birth date to distinguish members. Erased members and inactive plans never
match; ambiguous plan names need a plan UUID. Source IDs are not persisted as
member identifiers by the people mapper, so `externalId` cannot locate a member.

Optional `amountCents` is a nonnegative integer number of cents (including zero,
at most 2147483647); `interval` is `monthly` or `annual`. Missing prices and
intervals use the selected plan. Currency defaults to the plan's currency and
must match it when supplied. `commitmentEndsOn` can record a calendar date.
Unmapped or empty commitment dates preserve existing values on update. The
catalog is never changed by an imported price or interval override.

Each membership keeps the source's next date, even when it is in the past or a
future year. New rows are active and use the earlier of that date and today's
date in the gym's timezone as `startsOn`; the original join date is not available
in this mapping. Future-date mistakes can then be corrected through reimport or
the membership editor. An update before the existing `startsOn` is a row error;
other valid rows still commit. Importing creates no invoice, sign-up fee, trial,
charge, or email.
The ordinary charge runner collects on the stored due date when billing is
enabled, including its normal overdue-review policy. Annual rows record that
date as `anniversaryOn`, so February 29 returns in leap years. An annual update
on the same anniversary or its non-leap February 28 clamp keeps the original
anniversary when `billingDay` is absent. Switching to monthly clears it.

For an annual row, optional `billingDay` is the anniversary's day of month. It
must equal the day in `nextDueOn`, with one exception: `29` with February 28 in
a non-leap year restores a February 29 anniversary. Because the database stores
a real date, this inferred anniversary uses the next valid leap year (the
preceding leap year at the upper date boundary); the billing calendar uses only
its month and day. For example, `2027-02-28` plus `29` stores `2028-02-29`, bills
on February 28 in 2027 and February 29 in 2028, and keeps that anniversary after
renewal. Explicit days apply to new rows and updates; `28` explicitly replaces
an old leap-day anniversary with February 28.

Past due dates are accepted. The runner issues an invoice for each missed period,
charges dates up to seven days overdue on its next daily run, and holds older
ones for review. Export after the old system's last billing run and before its
next one, with the next date still unbilled there, to avoid charging twice.

The household anchor comes only from monthly source rows. An annual-only import
keeps its current billing day. Monthly rows in a family must agree, with short
month clamping allowed. An optional `billingDay` preserves a 29th–31st anchor
when the next date is in a short month. Otherwise a compatible existing anchor
is preserved, or the greatest day among the family's source monthly dates
supplies the anchor. Conflicting explicit anchors
or off-anchor monthly dates are errors. Existing active and pending monthly
schedules outside the import must also agree. Trial and frozen memberships keep
their own dates and do not choose or constrain the household anchor. The mapper
considers the full immutable file for these
checks and duplicate detection, including family rows in later chunks.
When an update moves the family's anchor, planned IDs, revisions, old due dates
and source due dates identify eligible monthly updates, including later chunks.
Preview and commit use the same eligibility checks. Under the household lock,
the anchor change also moves those later memberships to their source dates,
bumps their revisions and audits each change in the same transaction. If a later
chunk fails, these dates still match the anchor. Each later source row re-analyzes
against the new revision and applies the remaining fields when processed. An unrelated or
concurrently changed schedule cannot be silently moved onto the new anchor.

One member/plan pair identifies an existing live membership. Cancelled memberships
never count as duplicates or get edited: a returning member receives a new active
membership, and reimporting then matches that live row. Reimports use the
pipeline's `error`, `skip`, or `update` policy; multiple existing matches cannot
be updated. Later occurrences in the file are always duplicate errors, even if
they use a different combination of member identifiers. Updates preserve status,
join date and lifecycle metadata; only active or pending memberships can be
updated. CSV statuses other than active are rejected: manage trials, freezes and
cancellations through the membership lifecycle before importing renewals.

Each commit processes at most 100 source rows. Household locks serialize imports and runner
work; member and plan references are locked and revision-checked, as are
membership updates and household anchor edits. A concurrent insert or replay
never creates a second member/plan pair. Domain audits contain only IDs, billing
dates and the import ID; names, emails, source cells and processor IDs stay out
of append-only audits. All queries use the supplied gym-scoped transaction, with
no nested scope or network calls. Preview and dry runs never change domain rows.

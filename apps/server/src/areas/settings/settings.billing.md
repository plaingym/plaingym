<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing retry settings

`PATCH /api/settings/billing` requires `settings.manage` and accepts the gym's
current `revision` and `retryDays`: 0 to 4 strictly increasing integers from 1
to 28. The database default is `[3, 7]`. An empty array disables automatic
retries. Invalid days return a `retryDays` field error; stale revisions return
409. Updates write `settings.billing.updated` in the same transaction.

The settings projection includes `retryDays`. Invoice transitions read these
rules within the first-failure transaction and snapshot them in
`billing.invoice.dunning_started.after.retryDays`. Each retry effect retains
its chosen day, counted from that first failure at 09:00 in the gym's timezone.
Later settings edits never move existing effects or queued jobs. Existing
dunning audit rows without a schedule retain their original effects and jobs.
Every failed latest attempt still creates one dunning notification; an empty
schedule leaves the invoice past due with one notification and no retry.

`BillingSettings` exports a mobile-first settings section through
`billing.registrations.ts`. The central web registry imports feature
registrations at composition time.

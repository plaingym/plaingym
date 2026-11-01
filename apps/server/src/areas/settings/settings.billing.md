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

# Drop-in fee

`PATCH /api/settings/drop-in` requires `settings.manage` and accepts the gym's
current `revision` and `dropInChargeTypeId`: one of the gym's own active charge
types, or null for none. There is no separate price: the public drop-in page shows
the charge type's current price and currency through `createDropInFee()`
(`drop-in-fee.ts`), read on every page load. With none chosen, or with the chosen
charge type archived, the page asks visitors to contact the gym; it never infers a
fee by name or shows zero for a missing one. A charge type the gym doesn't have
(including another gym's, which row-level security hides) returns 404, an
archived one 409, and a stale revision 409. The reader also matches the charge
type on the gym, so a stale or foreign ID shows no fee. Updates write
`settings.drop_in.updated` in the same transaction.

`BillingSettings` and `DropInSettings` export mobile-first settings sections
through `billing.registrations.ts`. The central web registry imports feature
registrations at composition time. The drop-in section lists the gym's active
charge types with their prices; a saved, since-archived one stays visible as
archived and can't be saved again. Because every section on the page saves the
same gym revision, the drop-in section re-reads the settings before saving and
sends the current revision unless the drop-in choice itself changed since it
loaded. Saving the gym details or currency invalidates the shell's cached gym
summary (`bootstrapKey`), so other screens show the new currency or timezone at
once; the drop-in save invalidates it too, so the summary never lags a settings
save.

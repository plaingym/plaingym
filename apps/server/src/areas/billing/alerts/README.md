<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing alerts

`createBillingAlerts` accepts the job queue, gym settings, account service, and a
`prepare(gymId)` resolver for the gym's mail transport and canonical origin, plus
optional `gymName` and display `locale` (English by default). The runtime supplies
the gym name from the settings service. Without it the
translated fallback is "Your gym". Both notices use the shared React Email layout,
with the gym name, heading, body, action button and footer. Card dates use `Intl`
display formatting after conversion through the shared time helpers.
`configureBillingAlerts` supplies the pre-registered job handlers before the worker
starts. The daily scan runs at 09:00 in each gym's timezone; the dispute scan runs
hourly at minute 41 and reads invoice flags written by webhook handlers. The runtime
configures these jobs before starting the worker.

Each enabled card scan and each dispute scan prepares mail once and validates the
origin before enqueueing anything. Preparation failure leaves delivery keys unused
so a later scan can recover after SMTP is configured. A dispute scan also requires
an owner email before reserving its key; recipients are reloaded at delivery.

The card cycle is the earliest next due date among the household's active, trial,
or pending memberships with a positive amount. A card is valid throughout its
expiry month. Reminders start 30 calendar days before that cycle, with catch-up
through the due date. Frozen, cancelled, and free memberships do not trigger them.
The send job reloads the default card, expiry, cycle, household address, opt-outs,
deliverability, and the member-email switch before sending. Signed update-card
links expire seven days after the billing date; undelivered links are revoked.

Delivery keys are `billing.alert.card_expiry:<paymentMethodId>:<dueOn>` and
`billing.alert.dispute:<disputeId>`. The queue hashes each together with the job
name and enforces its existing gym-scoped unique constraint. The send job uses the
same key for durable send state (`infra/email/README.md`), whose rows are permanent:
**keep these keys under any queue-retention policy**, and never prune their
`email_deliveries` rows. Completed jobs survive process restarts, repeated scans,
and webhook replay.
The dispute query excludes invoices with a matching `billing.alert.dispute.sent`
audit event (gym, invoice target type/ID and JSON dispute ID); the permanent queue
key remains the final guard against concurrent scans. Resolved but unreported
disputes remain eligible. A different dispute on the same invoice is eligible too.

Send jobs explicitly allow **48 attempts for cards** and **18 for disputes**.
With the queue's default one-second exponential backoff capped at 24 hours,
the final attempts fall after 31 days and 12 hours, and 36 hours and 24 minutes,
respectively. This covers the card's 30-calendar-day window through the due date
(including DST), and more than one day for disputes. Every card retry rechecks
eligibility and stops without sending after the gym-local due date. Exhausted
jobs retain their keys; scans do not reset the retry budget.
Once SMTP accepted a notice, or may have (a lost reply, a partial acceptance, a
crash in flight), no retry sends it again. A card job checks the send state before
minting a link, so a delivered notice gets no second link; a possibly delivered
link stays usable rather than being revoked. Anything that provably did not send
the link (a refusal, a failed reservation, another attempt still in flight)
revokes it and retries. A notice whose send state outlived its audit (a crash in
between) gets the missing `.sent` audit on the next run. A dispute notice that may
have been delivered is audited `billing.alert.dispute.uncertain` and never resent;
the dispute scan treats that audit like `.sent`, so it stops finding the dispute.

Dispute email goes to `accounts.staffEmails(gymId, ['owner'])`, independent of the
member-email switch. A single message addresses the deduplicated owner list.
Resolved disputes are still reported if resolved between scans.

The runtime adds `createDisputeAlertProvider()` to `configureDashboard`'s additional providers.
Its `billing.disputes` extension uses the existing count renderer and requires
`billing.read`. It derives its count directly from invoices, including unresolved
statuses and excluding `won`, `lost`, and `closed`. The unresolved count clears
immediately, without a cleanup job or additional persistence. The provider
requires a widget and the registry always renders it. TODO: allow an optional
provider result to hide the zero-count card. No new HTTP routes are added. The
dispute email links to `/admin/billing/invoices/<invoiceId>` on the gym's configured origin.

The household recipient/opt-out logic also exists in signed-link delivery and
transition notifications. TODO: consolidate the three callers with a shared
recipient helper.

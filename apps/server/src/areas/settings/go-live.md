<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Go-live switches

`createGoLiveService({ smtpConfigured, scope, clock, webhooks })` supplies the go-live
GET and PATCH contracts. Runtime composition calls `configureGoLive` with the gym's
SMTP resolver (or the demo transport's configured check). Until configured, routes
return 503. Route generation can discover both endpoints without opening a database
or loading credentials.

Reads return only switches, revision, and the contract's complete readiness checklist.
Readiness checks are scoped to the gym: setup completion, non-erased members, class
templates, payment configuration, SMTP, and backup configuration. Paid active,
trial and pending memberships need a linked customer and an unrevoked default card
(a known past expiry month needs attention). Active members need signatures on
every current, non-retired waiver/agreement family. An older signed version does
not satisfy the current version, and a retired latest version never revives an old
template. With no applicable memberships or waivers those checks are not applicable.

Webhook readiness uses `WebhookHealthQuery`, implemented by the real inbox by
default: a processed event and no pending/failed events are ready. It never reads
webhook payloads. Reconciliation flags pending payment attempts/refunds and any
restore without a successful latest check reporting zero unresolved objects.
Each check belongs to a specific restore receipt; each result belongs to that check.
An earlier restore's successful check cannot clear a newer restore, even when the
injected clock has the same instant for both. A delayed earlier check cannot replace
the newest check's result. Restored gyms
cannot enable billing until that check is clear; turning it on is the manager's
explicit confirmation after reconciliation. The remaining readiness checks advise
the manager. Viewing the checklist does not require a live Stripe request.

Restore queues `billing.runner.restore` for each restored gym, using the manifest's
snapshot time and an idempotency key derived from that gym's restore receipt. The
queue is durable before the restore journal becomes complete. Repeating an
interrupted publication reuses the same job. The restore receipt's snapshot time
is also recorded for subsequent reruns.

`POST /api/settings/go-live/reconciliation` requires `go_live.manage`, the current
gym revision and `restoreId`. It rejects a different gym's restore, stale revision
and enabled billing. The page's **Check restored payments again** button calls
the same configured runner as the worker, outside any transaction. It displays
progress, safe errors, the last result time and inspected/unresolved counts from
`restoreReconciliation`. A requested or interrupted check invalidates the prior
success until the new check completes. Provider failures record an unresolved
result; managers can correct configuration or payment issues and rerun. The check
never enables billing. Existing runtime runner configuration serves this action
without additional wiring.

`past_due_dates` lists every active membership whose `next_due_on` precedes the
gym's local today, including annual renewals and dates imported from another
system. Dates equal to today are excluded. The response's `pastDueMemberships`
contains membership/member IDs, member and plan names, due dates and revisions;
it is optional on the contract for compatibility, and this service always supplies
it. The web page lists them and requires explicit confirmation before enabling
billing. The PATCH sends `confirmedPastDueDates` as `{ id, revision, nextDueOn }`
snapshots. The service locks the matching memberships and compares the whole set
when billing changes from off to on. A changed date/revision, newly past date at
midnight, missing membership or duplicate/foreign confirmation returns 409 and
leaves both switches unchanged. Turning billing off and editing member email
remain available without a date confirmation.

Updates compare revisions and audit the before/after switch values in the same short
transaction. Credentials and other gym settings never appear in responses or audits.
Confirmed dates get a separate `settings.go_live.past_due_dates_confirmed` audit
containing membership IDs, dates and revisions, with no names. The SMTP resolver
and webhook accessor run outside transactions because they open their own gym
scopes. Calendar dates use the injected clock and the gym's IANA timezone.

The web settings registration requires `go_live.manage`, renders every returned
checklist item, and reloads current values on a revision conflict. The confirmation
dialog uses the shared phone/full-screen dialog and an explicit checkbox.

## Switch inventory

`go-live.inventory.test.ts` inventories the production charge, customer, Checkout
and mail boundaries. Adding a direct outbound call requires classifying it and
pointing to regression coverage. `go-live.switches.test.ts` exercises persisted
switches with real PostgreSQL and fake payment/email providers.

| Entry path | Switch behavior / coverage |
| --- | --- |
| Daily/catch-up, retry, staff one-off/invoice, assignment proration/sign-up fee, zero settlement | Runner checks `billingEnabled`; `runner/runner.test.ts` and `go-live.switches.test.ts` |
| R6 signed pay links: cycle/assignment/one-off Checkout and lazy customer creation | Refuses paused billing before customer creation or Checkout reservation; also checks before provider Checkout and exposing new/reused URLs |
| R6 card/onboarding setup and lazy customer creation | Allowed with billing paused; setup does not charge. Cycle/assignment pay links save cards, ordinary one-off pay links do not |
| Existing provider results, saved-card webhooks, reconciliation | Continue accounting for payments already started while billing is paused; never create a new charge |
| Cash/check recording, refunds (including duplicate refunds) | Accounting/refunds remain available while new card charges are paused |
| Member-targeted mail | `MemberEmail` reloads the switch and member suppression flags |
| Receipts/resend and dunning/SCA | Check `memberEmailsEnabled` at recipient selection and immediately before each send, after asynchronous preparation; suppressed dunning links are revoked |
| Signed pay/card/waiver/onboarding email | Reloads the persisted switch immediately before delivery; suppressed undisclosed links are revoked |
| Card-expiry mail | Checks before scanning and rechecks before queued delivery; `alerts/alerts.test.ts` |
| Staff invitations, requested login links, duplicate-payment and dispute owner alerts, SMTP test | Staff/security/administrative mail remains available with member emails paused |

All switch regressions assert passing behavior against the real services and fake
providers. `go-live.readiness.test.ts` covers the GET, rejected unconfirmed PATCH
and confirmed PATCH through `createApp` and the real registrations.
`health/restore.test.ts` exercises encrypted restore, durable publication, the
production worker and go-live rerun routes against PostgreSQL, including interrupted
publication, unresolved/resolved payments, provider failure and a newer restore.
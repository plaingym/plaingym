<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Payments adapter

`listCustomerCards(customerId, { householdId, cursor?, limit? })` reads one page
of attached cards (1–100, default 100), returning masked card details, processor
creation times and an opaque next cursor. It requires the customer's metadata to
name this gym and refuses metadata naming another household, cards from another
customer or gym, and malformed pages. It never adopts an untagged customer or
changes Stripe's default. A rejected continuation raises `CardCursorRefused`;
ownership refusals raise `CardImportRefused`. `FakePayments` implements the same contract.

The provider reads three payment method types. A `card` has expiry fields and
an optional brand. A `us_bank_account` (ACH) or `acss_debit` (Canadian PAD) has
the last four digits and an optional bank name. Pass `types` in the listing
options to include bank accounts. Accounts without last-four digits are
skipped. In a mixed listing a page can be empty and still have a continuation.
When a customer's metadata names a household, supply its matching `householdId`.
Pass `includeMandates` to resolve Canadian PAD mandates from the customer's
successful off-session SetupIntents. The adapter retrieves the mandate by ID
and verifies that it is active, reusable and references the same payment method.
With an existing restricted key that lacks **Mandates** read access, the adapter
marks the affected Canadian account as permission denied. The household import
skips and counts that account and continues with the other methods.

The people CSV mapper uses `readBankAccountForImport` for new Stripe payment
method IDs. The read accepts an untagged customer in the configured Stripe
account, enforces gym tags when present and returns the customer and optional
household tag for comparison with the CSV row. The ordinary payment-object read
still requires gym ownership. The import read never changes Stripe metadata.
The CSV preview makes no Stripe reads. Dry runs and both run protocols mark a
row as an error after a denied mandate read or other provider failure, and when
the gym has no Stripe connection for a new `pm_` ID. They record the
row-specific message, and other valid rows remain eligible to commit.

Staff choose **Import cards from Stripe** on household billing or invoice details
(`payments.record`). The import commits at most 100 cards per background job,
atomically queues its continuation, deduplicates processor IDs and keeps revoked
cards revoked. It rechecks the local customer link and test-to-live switch after
provider reads. Ownership changes finish as stale, cards already stored for another
household are skipped. A refused cursor or a change of the gym's currency
restarts listing, at most three times in total, without saving the listed page.
Each request records its restart, completion, refusal or stale outcome in the
audit trail, including the cards and bank accounts already imported, skipped
methods and restarts. A refusal at the limit records whether a cursor or the
currency caused it, and also settles a default for methods already imported.

Imports, card removal and clearing test cards share default promotion. An existing
default stays selected; otherwise cards are ordered newest first by processor
creation time when known (local creation time otherwise), then local creation time,
then row ID. The first card whose stored expiry month has not passed in the gym's
timezone is promoted; if every remaining card has expired, the newest is promoted.
No customer IDs or processor IDs enter the route response. The billing runner
then uses that stored default normally; campaign filtering still uses local rows.

The `Payments` types, `FakePayments`, and `normalizeChargeOutcome` are exported
from `index.ts`. Import `StripePayments`, `stripeTransport`, and
`STRIPE_API_VERSION` from `stripe.ts`. Only this directory imports the Stripe SDK
(`stripe` **23.0.0**). All requests and webhook registrations pin
**2026-09-30.endive**. Endive requests use `allowed_payment_method_types`.

Construct one adapter per gym, with that gym's decrypted configuration. Every method
rejects use inside an application transaction before making requests. The adapter
creates an unconfirmed intent; the caller commits its ID using the attempt CAS,
then calls `confirmCharge` with the separate confirmation key. Unknown network
outcomes throw and must be reconciled by ID. Never interpret them as a decline.
`attemptId` is the local attempt ID; `attempt_n` comes from the numeric segment in
the `invoice_id:attempt_n:create` key. Use the persisted request parameters on retry.
Amounts go to Stripe and come back exactly as stored: positive integers in the
currency's minor units (500 is $5.00, ¥500 or 0.500 KWD) with a lowercase ISO code,
in any currency; nothing here converts them.

Explicitly created Customers, intents, Checkout sessions, inline Products, refunds,
and webhook endpoints receive `gym_id` metadata. Checkout also puts metadata on its
PaymentIntent or SetupIntent. Stripe-generated child objects are matched through
their parent: a card's Customer, or a refund/dispute's Charge and PaymentIntent.
Customers created elsewhere (imported Stripe customer IDs) carry no `gym_id` and are
refused until `adoptCustomer(id)` tags them; it is idempotent and refuses customers
tagged for another gym. Call it only on staff-provided IDs. A test key can't see
live-mode objects, so a live customer it reads looks missing, as one from another
account does; `keyMode` (`test` or `live` for `StripePayments`, unset by default
on `FakePayments`) lets callers tell which key they hold. Email matches are
restricted to tagged customers and ambiguity fails closed. The saved
method is returned explicitly; a Checkout success never implies a Customer default.

`CheckoutSession.savesCard` is derived from the payment intent's
`setup_future_usage` (or setup mode). Stripe creates a payment session's intent
only when the payer pays, so an open session reads it from its own
`saves_card` metadata, set from the same request. A payment Checkout without
that setting does not require an attached card. `StripeFixtures` creates the
intent on the first attempt (`attemptCheckout`) or completion, as Stripe does. `PaymentMethod.createdAt` comes from the
provider's `created` timestamp; the fake captures its clock when the method is
first recorded and preserves it across updates. Consumers store that time to
order defaults independently of webhook arrival or event retention.
Payment methods also carry an optional card `brand`; new locally collected cards
store it, while existing rows keep their stored value. Checkout requires a
`customerId` and never creates a customer from an email address. An optional
`expiresAt` becomes the session's `expires_at` (Stripe accepts 30 minutes to 24
hours after creation) and is part of the idempotent request; without it the
provider default applies. The fake reports an open session as expired once its
clock reaches that time.

`createCheckout` offers cards by default. Pass `bankDebit: { type: 'us_bank_account' }`
to also offer instant ACH verification with the Financial Connections
`payment_method` permission. For Canadian PAD, pass
`bankDebit: { type: 'acss_debit', intervalDescription }` with the gym's description
of regular and occasional debits. The session requests instant verification
and a combined personal mandate. Setup sessions specify CAD on both the
session and the ACSS option. Payment sessions take currency from the invoice
line item. A bank-enabled session raises `BankDebitUnavailable` if Stripe
rejects the payment method types list or a US or Canadian bank option, including
nested verification, Financial Connections and currency fields. The signed-link
flow records `billing.bank_debits.unavailable` and opens a card-only Checkout.
Refusals of mandate options propagate to the caller.
A bank method missing four usable last digits is omitted from listings. When a
direct read verifies the method's gym and customer, it reports the incomplete
bank method separately from other unknown results. Checkout can finish without
saving that method.

`CheckoutSession.paymentStatus` reports `paid`, `unpaid` or `no_payment_required`.
A completed bank payment can still be unpaid while its intent processes.
Payment sessions expose the latest Charge's bank mandate as `mandateId` when
available. Setup outcomes expose the SetupIntent's mandate. For an off-session
PAD, supply that ID as `createCharge.mandateId` on the request. The adapter
stores it in the unconfirmed intent's metadata and sends it as `mandate` on
confirmation, including after a restart. Stripe refuses to confirm a
`processing` intent, so `confirmCharge` reports one as it stands without
another request.

The normalized outcome carries the bank method type and `processing` while
the debit settles. Insufficient funds maps to `insufficient_funds`. Other bank
failures that require a new method map to `payment_method_unusable`.
`FakePayments.settleCharge` accepts either failure or `succeeded`.

In `StripeFixtures`, bank confirmations start in `processing`.
`settle(intentId)` updates the intent and returns a Stripe webhook event.
`pm_usbank_6789` and `pm_acss_6789` succeed. `pm_usbank_2227` fails with
`insufficient_funds` and `pm_usbank_1113` with `account_closed`.
Both the fixture and `FakePayments` accept `completeCheckout(id, { method })`
to select an offered method. The default is a card.

A successful outcome's `succeededAt` is its latest Charge's `created` timestamp.
Every PaymentIntent read and the confirmation expand `latest_charge`, so a
successful confirmation or lookup carries it without another request; the
expanded Charge must name the intent as its parent and carry a valid time, or the
outcome has none. `findCharge(reference, { includeSuccessTime: true })` requires
it: without an expanded time it retrieves the latest Charge, verifies its parent
intent and reads `created`. Missing/invalid time or an unresolved Charge fails
the lookup; callers must not substitute their processing clock. The fake records
success time when confirmation or Checkout completion succeeds and keeps it on
later reads.

`createCharge` reads the saved payment method with its customer expanded: one
request checks both that the method is attached to the payer and that the payer
carries this gym's `gym_id`, before the intent is created. A successful saved-card
charge makes four requests: that read, the create, the confirmation's ownership
read and the confirmation. The charge runner's customer adoption adds a fifth,
and a sixth when it first tags an untagged customer.

`isProviderOutage(error)` tells an error with which the provider could not serve
the request at all (unreachable or timed out, rate limited, a server error, or
the gym's key rejected) from one about that request only (a decline, a missing or
foreign object, an invalid request, or a permission the key lacks, since requests
that don't need it still succeed). It reads the SDK error's type and status, so
callers need no SDK import; the charge runner uses it to stop its daily
collection during an outage.

`listRefunds(paymentIntentId)` checks intent ownership and pages
`GET /v1/refunds?payment_intent=<id>&limit=100`, following `starting_after`.
It returns all current refunds for that intent, including untagged dashboard
refunds, and refuses a mismatched parent. It never scans events or unrelated
payment intents/disputes. Refunds can be refreshed individually with
`readPaymentObject` before applying invoice transitions; its `unknown` answer carries
`missing: true` only when Stripe answers not found for the refund itself, never for a
missing charge or parent intent, another gym's metadata or an uncertain read.

`refund` takes an optional `reservationId`, sent as `reservation_id` in the
refund's metadata and read back from that metadata only, never the parent's. It is
part of the idempotent request: a retry must repeat it, or its absence, exactly.
A refund made outside the app has none.

Refund status is normalized to `succeeded`, `pending` (including
`requires_action`), `failed`, or `canceled`. A canceled refund was cancelled at
the processor before it completed, usually by staff in the dashboard; it is kept
apart from `failed` so the app doesn't report it as a failure. Neither returns
money, so `FakePayments` lets the charge be refunded again. `respondNextRefund`
creates the next fake refund with another status (such as `pending`), and
`setRefundStatus` moves a stored fake refund as a later processor report can: a
pending one to any status, a successful one to `failed`.

Dispute status is normalized to `open`, `won`, `lost`, or `closed`.
`warning_closed`, legacy `charge_refunded`, and `prevented` map to `closed`,
without claiming a win or loss. Consumers preserve terminal states on stale
delivery. The invoice dispute-status column is nullable text; no dispute-status
CHECK constraint exists in the current schema.

`parseWebhook` verifies the exact bytes and timestamp through the SDK. It only
extracts identity and routing from signed events. Events without gym metadata
(including dashboard refunds and disputes) require parent lookup. Read the body
once, call the provider outside a transaction, then insert the verified event into
the inbox. Fetch object state through `readPaymentObject` before applying billing
transitions. Import `PaymentWebhookError` from `webhook-error.ts` to distinguish
these outcomes in the webhook inbox:

| Error code | Meaning | Inbox response |
| :--- | :--- | :--- |
| `webhook_not_for_gym` | Valid signature; untagged after parent resolution, another gym's object, or an unsupported object | **200**, drop without inserting or processing |
| `webhook_invalid` | Bad/expired signature, malformed payload, or test/live mode mismatch | **400** |

Stripe API errors during identity or parent lookup retain their original error;
return a retryable non-2xx response. A missing parent is an API failure, not proof
that an event belongs elsewhere. The fake does not produce these error codes.

`listChangesSince` reads every event page and re-fetches the referenced objects at
the pinned version. It then pages through PaymentIntents, refunds, and disputes by
creation time, covering objects older than event retention. Refunds and disputes
resolve through their payment even when their own metadata is empty. The opaque
cursor binds gym, snapshot time bounds, resource, and Stripe's last ID. Persist it
with the original `since`; process until `nextCursor` is null. Duplicate objects
are expected and transitions must be idempotent. A genuine missing object (a
provider 404) blocks the pass with its reference for manual resolution. Existing
objects without gym metadata after parent resolution, including unrelated
Dashboard charges and their refunds/disputes, are excluded along with other gyms'
objects. Stripe and the fake also skip bank methods without four usable last
digits. The fake filters these methods before applying its pagination offset.
Provider/network errors still fail the pass. `readPaymentObject` and
`findCharge` return `unknown` for objects that are missing or not this gym's.
Do not use search to decide whether a charge happened.

`stripeTransport` puts GET filters in the URL: the SDK's `rawRequest` accepts
parameters as a body only for POST. Read filters retain Stripe's bracket notation
for creation bounds and pagination.

`stripeProvisioner` probes the complete restricted-key profile with reads and
nonexistent-ID write probes. The Mandates read probe retrieves a nonexistent
mandate and accepts Stripe's missing-resource response. The Webhook Endpoints
write probe posts an update to the nonexistent endpoint
`we_PlainGymPermissionProbe`, and a key without write access
fails with `Check the Stripe permission for Webhook Endpoints`.

## Webhook endpoint lifecycle

Stripe returns an endpoint's signing secret only when it creates the endpoint.
Credentials and the secret are stored together, encrypted as `stripe_config`, so
the stored endpoint is kept whenever it still applies, and a new one is created
only when it does not.

- **Registration** (`register(gymId, origin, revision, previous?)`) reads the
  stored endpoint with the key being saved. The endpoint is kept, with its stored
  secret, when that key's account still has it, it carries this gym's `gym_id`
  metadata, its URL is this install's `/webhooks/stripe`, and its API version is
  the pinned one. A kept endpoint that lacks any event in `STRIPE_EVENTS` is
  updated first. Otherwise a new endpoint is created with a deterministic key
  (`gymId:webhook:revision`). Registration deletes nothing, so a save that loses the
  revision race leaves the stored settings and their endpoint untouched; an
  unreferenced new endpoint is deleted by the next successful save.
- **Cleanup** (`retire(gymId, origin, keep)`) runs after the new settings are saved.
  It deletes every other endpoint in the key's account whose `gym_id` metadata is
  this gym and whose URL is this install's `/webhooks/stripe`, paging through the
  whole list. Endpoints without this gym's `gym_id`, and this gym's endpoints at
  other URLs, are never touched.
- **Account change.** When the key moves to another account, the stored endpoint
  is not visible to the new key, so a new endpoint is created. The old one is then
  deleted with the old key (`remove(gymId, origin, endpointId)`), only if it still
  carries this gym's `gym_id` and this install's URL. If the old key is refused,
  the failure is logged through the redacting logger and the save still succeeds.
  Skipping Stripe after it was configured removes the stored endpoint the same way.
- **Events and API version** (`check(gymId, origin, stored)`) compares the stored
  endpoint's `enabled_events` and `api_version` with `STRIPE_EVENTS` and
  `STRIPE_API_VERSION`. Different events are updated in place. Stripe cannot change
  an endpoint's API version, so an endpoint at another version is replaced: a new
  endpoint (key `gymId:webhook:replace:<endpointId>:<version>`, so a retry returns the same
  endpoint) whose secret the caller stores, followed by `retire`.
- **A deleted endpoint** (for example, removed in the Stripe dashboard) is recreated
  the same way, since the key can only be saved during setup. Only a 404
  `resource_missing` on the stored ID counts as missing; an outage, permission or
  authentication error is raised and retried at the next start, never treated as
  missing. The new endpoint uses the key `gymId:webhook:recreate:<endpointId>`, so
  repeated or concurrent runs create at most one. An endpoint that exists but is not
  tagged for this gym, is at another URL or is in the other mode is reported as
  `skipped` and left alone.

`areas/setup/stripe-step.endpoints.ts` runs `check` for every gym with Stripe
settings in the background after the server starts (`core/runtime.ts`), and the
Stripe setup step applies the same event update when settings are saved. Replacing
or recreating an endpoint compare-and-sets the stored settings and writes an audit
event (`payments.webhook_endpoint_replaced` or `payments.webhook_endpoint_recreated`,
with the before and after endpoint IDs), then retires the gym's other stale
endpoints; if the settings changed meanwhile, the new endpoint is deleted unless
the concurrent save stored it. Stripe being unreachable, or any error for one gym, is logged and never
delays startup or the other gyms; the check runs again at the next start or save.
Sandboxes use the shared test account and register no endpoint, so they skip it.

New endpoints subscribe to `payment_method.automatically_updated` as well as
`payment_method.updated`. Endpoints created by earlier releases receive the current
events at the next start or Stripe settings save.

## Offline contracts and recording

`detachPaymentMethod(id)` checks the attached customer's gym before calling
[Stripe's detach endpoint](https://docs.stripe.com/api/payment_methods/detach).
Missing and already detached methods succeed; a concurrent detach or lost response
is confirmed by reading the method again. Permission and provider failures remain
retryable. Payment Methods **Write** is required and probed during setup. Existing
keys without it report `Check the Stripe permission for Payment Methods`; local
card revocation remains in place while the queued detach job retries.
`detachPaymentMethod(id, { redactBillingDetails: true })` is for member erasure only
(a staff card removal passes no options): Stripe
[updates only an attached card](https://docs.stripe.com/api/payment_methods/update),
so before detaching it clears the card's billing name, email, phone and address (an
empty string clears each) when it holds any. A method Stripe won't leave without a
billing name or email (a pre-authorized debit account, refused with `parameter_missing`
on `billing_details[name]` or `[email]`) gets the fixed placeholders instead: the name
`Erased member`, the email `erased-member@example.com`, and a blank phone and address;
it is then detached. A method holding nothing, or only these placeholders, counts as
redacted and gets no further write. A failed clearing or placeholder write is raised
before the detach, so the retry still finds the card attached; a card that is already
detached keeps what it holds, since it can no longer be updated.

`clearCustomerEmail(id, { householdId, emailDigest, secret, paymentMethodIds })` handles
erasing a payer while other household members remain. It returns `{ matched, placeholderMethods, failedMethods }`:
`matched` says whether an address matched and was cleared (false for a no-match, missing or deleted customer). It clears only the customer
email and every specified card's billing email that match the digest of the
trimmed, lowercased erased address. It preserves names and other billing fields,
and keeps the cards attached. A card Stripe won't leave without an email (a
pre-authorized debit account) gets the placeholder `erased-member@example.com`
instead, its name unchanged. A debit account already holding that placeholder counts
as cleared (even when the erased address itself normalizes to it), so a retry writes
nothing and doesn't count as a match. `placeholderMethods` lists the specified
`acss_debit` methods holding the placeholder when the call ends, whether this call or
an earlier one wrote it; the caller retires them. A card or other method holding the
same address follows the matching rule and is never listed. Each method is written on
its own: a failed write adds the method to `failedMethods` and the call goes on to the
next, so a debit account cleared earlier in the call is still listed. After a 401 or
403 no further method is written, and every method left is listed as failed too.
If the ownership check already found the placeholder on one of those debit accounts,
it appears in both lists so the caller can retire it immediately. A
failed customer write still throws. The fake always returns empty lists. The digest is a versioned HMAC under a key derived
from `AUTH_SECRET`; `secret` is supplied only during execution, never in a job or
audit, and fixture recording redacts it. Legacy jobs with a plain digest and
`paymentMethodId` still drain. Before any write it refuses customer metadata naming
another gym or household, a card naming another gym, or a card attached to another
customer. Untagged imported customers require the caller's checked local household
link. Missing and deleted customers, missing cards and detached cards are harmless;
detached cards cannot be updated. Every retry reads current addresses and only
writes matching fields, without a cached idempotency response. Customer and card
writes are independent, so a retry completes a partially successful clear without
overwriting replacement emails. The fake exposes the cleared customer and billing
fields through `customer()` and `billingDetails()`. This uses the existing Customers
and Payment Methods **Write** permissions. Stripe edits between the read and write
cannot be made atomic; the adapter checks ownership and values before calling.

`redactCustomer(id)` serves member erasure. It refuses a customer tagged for another
gym and, as `adoptCustomer` does, treats an untagged one (an imported ID) as the gym's; it then
[updates the Customer](https://docs.stripe.com/api/customers/update) so its name
is `Erased member` and its email, phone, address, shipping details, description,
individual name, business name and invoice custom fields are cleared (an empty string
clears each; the individual and business names and the custom fields are sent only when the
customer holds them, so an API version without them is never sent them), and it deletes the
customer's tax IDs (a separate list per customer, deleted after the customer's own fields so a key without
permission for them, reported as `Check the Stripe permission for Customers (tax IDs)`, still has those cleared). A customer adopted from the dashboard may
hold any of them. The Customer, its ID, its metadata and its payment and dispute history stay, because the gym
keeps them for disputes and tax; the adapter never deletes a Customer. Missing,
deleted and already redacted customers (name, email and all other details cleared, no tax ID) succeed without a write, so the call is
safe to repeat. Erasing a household's last member commits first, then calls it
with the customer ID the erasure cleared; a durable `members.erasure.redact_customer`
job carries that ID and retries when Stripe is unreachable. It uses the Customers
**Write** permission that customer creation already needs. It also
[lists attached payment methods](https://docs.stripe.com/api/payment_methods/list) of every type, 100 per page,
and clears each method's billing name, email, phone and address without detaching it,
using the existing Payment Methods **Write** permission. A method Stripe won't leave
without a billing name or email (a pre-authorized debit account) gets the same
placeholders as the erasure detach and stays attached; a method holding only the
placeholders counts as cleared. This covers dashboard-added
cards, bank accounts and revoked cards whose detach has not succeeded. A method
tagged for another gym is skipped with an identifier-only warning. Tax IDs are deleted
before payment-method cleanup. Authentication and permission failures stop
payment-method cleanup immediately. Other method errors allow the remaining
methods to be attempted before the error is reported for retry. If tax ID
cleanup also fails, its error takes precedence. Already cleared details cause
no further write, and other customers' methods are left alone.

`adoptCustomer(id)` raises `CustomerDeleted` (exported from `index.ts`; the fake raises it
for a customer seeded as `deleted`) when Stripe reports the customer deleted, so callers
can tell it from a transient failure.

Run from the repository root with the pinned Node version:

```powershell
pnpm exec vitest run --config apps/server/src/infra/payments/vitest.offline.config.ts
```

This needs neither PostgreSQL nor network access. The same `fullPaymentsContract`
scenarios run against `FakePayments`, the actual Stripe adapter with synthetic
API responses, and the actual adapter with serialized strict replay. The committed
`stripe.synthetic.json` is **synthetic**, not evidence of a real API run. Cases cover
4242, 0341 saved-card decline, 3155 after setup authentication, and 3184 renewal authentication, two-step
charging, idempotency, cancellation, refunds, Checkout, and change pagination.
Additional tests cover raw signatures, expiry races, metadata, parent matching,
foreign gyms, permission failures, and transaction guards. `webhook-endpoints.contract.ts`
runs the endpoint lifecycle (reuse, event updates, cleanup that leaves foreign
endpoints alone, recreating a deleted endpoint, removal) against `StripeFixtures` and, in the opt-in run, the Stripe
test API; `setup.test.ts` adds API-version replacement, paging, refused deletes and the
write probe. Database authorization, encryption, audit, revision-race, account-change and
refused-old-key tests are in `areas/setup/stripe-step.test.ts`, and the startup check is
tested in `areas/setup/stripe-step.endpoints.test.ts` and `core/runtime.stripe-endpoints.test.ts`.

`StripeFixtures` answers `expand` as Stripe does: the response inlines each named
object, while the stored object keeps its ID reference.
`FixtureRecorder` records either the public interface or the transport. It redacts
keys, signing secrets, client secrets, card numbers, and CVC. Use only a synthetic
payer in a test account: other personal fields are intentionally not rewritten,
so the request can replay exactly. `Replay` has no network fallback and rejects
changed requests, wrong gyms, and missing exchanges. Dates and bytes round-trip.
To deliberately refresh synthetic fixtures, set
`PAYMENTS_WRITE_SYNTHETIC_FIXTURES=1`, run the offline suite once, then unset it
and run again to verify replay. Review fixture diffs.

## Opt-in test API contracts

Verified against Stripe's test API on **2026-10-23**, with the actual adapter using
only a restricted test key at **2026-09-30.endive**. All **14 real-API tests** passed
(12 shared contract scenarios, permission validation, and endpoint registration;
97 tests total in the final combined offline/real run):

| Scenario | Real result |
| :--- | :--- |
| Two-step charge, repeated create/confirm, ID lookup | Pending before confirm, succeeded afterward; retries idempotent |
| Unknown PaymentIntent / Checkout ID | `unknown`, never treated as a failed charge |
| Changed immutable parameters under one key | Rejected |
| Cancel unconfirmed intent | Canceled without charging |
| Refund, repeated refund, refund lookup through parent | Succeeded and idempotent |
| Open payment/setup Checkout expiry; repeated or missing expiry | `expired` / `uncertain` as specified |
| Paged reconciliation with fresh reads | Current succeeded charge found |
| Restricted-key profile including Setup Intents Read | Every probe passed; nonexistent-ID write probes returned 404 `resource_missing` |
| Tagged webhook registration | Pinned version and signing secret returned; the run's reserved `.invalid` endpoint was deleted afterward |

Saved-card outcomes used one tagged test Customer with attached methods:

| Card | Real off-session result |
| :--- | :--- |
| 4242 | `succeeded` |
| 0341 (`pm_card_chargeCustomerFail`) | `failed` |
| 3155 | `succeeded` after its setup-mode Checkout and 3DS challenge completed on Stripe's hosted page |
| 3184 | `action_required` |

**0341 replaces 9995 for saved-card decline.** Stripe rejected attaching 9995 with
`card_declined` / insufficient funds, using both its token and named test method.
A separate **9995 on-session payment Checkout** declined on Stripe's hosted page;
the session remained **open and unpaid**, also confirmed through `readPaymentObject`.

Headless Edge also completed a payment-mode Checkout with `setup_future_usage` and
4242, and the setup-mode Checkout with 3155. The restricted adapter verified the
completed sessions, saved methods, successful payment lookup by session/intent,
successful setup read, and `already_completed` expiry. `findCharge` returns
`unknown` for a completed setup session because setup creates no charge.
A separate real reconciliation pass skipped an untagged customer/payment method
and customerless PaymentIntent while retaining a tagged charge.

**Unverified:** the endpoint lifecycle scenarios and the Webhook Endpoints write probe (they are in the opt-in run but were added after it),
the expanded payment-method customer and `latest_charge` reads (also added after it, and covered by the contract's success-time check), real HTTPS webhook delivery (deployment stage 2), actual inbox
integration, and a real dispute lifecycle. Offline signature/parent-resolution
tests and real Disputes Read probes do not prove delivery or dispute transitions.
No real transport recordings, credentials, or account IDs are committed;
`stripe.synthetic.json` remains entirely synthetic. Never use a live key for this run.

Prepare a dedicated Stripe test account and a restricted test key with the full
permission table in `STRIPE_PERMISSIONS`:

| Resource | Permission |
| :--- | :--- |
| Customers | Write |
| Payment Intents | Write |
| Checkout Sessions | Write |
| Setup Intents | Read |
| Mandates | Read |
| Payment Methods | Write |
| Charges and Refunds | Write |
| Webhook Endpoints | Write |
| Events | Read |
| Disputes | Read |
| Everything else | None |

Prepare a test Customer tagged with the contract gym ID and four attached saved
PaymentMethods. Use test card 4242 (success), 0341 (saved-card decline), 3155 (finish its
on-session Checkout/SCA setup first), and 3184 (off-session still needs SCA).
Also provide `detach: { "owned": "pm_disposable", "foreign": "pm_other_gym" }`
in the fixture JSON: a separate disposable method attached to this gym's customer
and one attached to a customer tagged with another gym. The owned method is detached
permanently; never reuse one of the four charge fixtures for it.
Store only the IDs, never card numbers or keys, in a local ignored JSON file
outside tracked paths (for example, the parent workspace's ignored `scratch/`):

```json
{
  "gymId": "00000000-0000-7000-8000-000000000001",
  "customerId": "cus_replace",
  "methods": { "4242": "pm_replace", "0341": "pm_replace", "3155": "pm_replace", "3184": "pm_replace" }
}
```

Set `STRIPE_TEST_RESTRICTED_KEY` in the environment, `STRIPE_CONTRACT_FIXTURES` to
that file, and `STRIPE_CONTRACT_MODE=test-api`. Then run the command above. The
exact same contracts run against the real adapter over Stripe's test API, plus
the permission checks, and a charge and refund in JPY (zero-decimal) and EUR whose
amounts must come back unchanged. The harness requires `rk_test_` and a test-only transport;
live keys are rejected before any request. It creates test payments, refunds,
and open/expired Checkout sessions, plus a pinned-version webhook endpoint at a
reserved `.invalid` URL (its ID is printed for review). Delete the test endpoints
after the run and record their IDs in the private task handoff. The suite never
deletes account objects itself.
Optionally set `STRIPE_RECORDING_OUTPUT` to a temporary file outside the repository
and delete it afterward. Never commit real recordings, account IDs, or credentials;
keep `stripe.synthetic.json` entirely synthetic.
Replay through `replayTransport`; do not substitute event payloads for fresh reads.
On subsequent runs, separately complete payment/setup Checkout on Stripe-hosted
pages and verify `findCharge`, `readPaymentObject`, `expireCheckout`, and the returned
saved method for completed sessions. Real HTTPS webhook delivery remains unverified
until the deployment-stage check; local signature tests do not verify delivery.

## Setup integration exports

`createStripeStep({ key, origin, scope?, clock? })` validates owner, progress and
revision in a short transaction, provisions Stripe outside transactions, then
saves encrypted configuration and an audit atomically with a revision guard.
`createStripeStepRoutes(step)` implements the existing PUT `/api/setup/stripe`
contract. Replace the old skip-only registration; never mount both.
`createPaymentsResolver({ key, scope?, clock? })(gymId)` returns the configured
adapter or null. No credentials or SDK types cross the interface.

The registered web `StripeStep` is phone-first, masks its key, shows all required
permissions, and clears the key on success or failure. After a successful connect,
it confirms the connection and shows the Stripe mode when known. It shows the
webhook address when registration succeeds and points to Payments settings
otherwise. **Continue to backups** refreshes setup status, and **Set up later**
refreshes it immediately. The wizard renders `setupSteps.setup.stripe` at step 6
and can advance whenever a status refresh reports the next step, including on
window focus. The English labels live in `locales/en/setup/stripe-step.json`.

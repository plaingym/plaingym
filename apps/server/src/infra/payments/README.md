<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Payments adapter

The frozen `Payments` types, `FakePayments`, and `normalizeChargeOutcome` stay exported
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

Explicitly created Customers, intents, Checkout sessions, inline Products, refunds,
and webhook endpoints receive `gym_id` metadata. Checkout also puts metadata on its
PaymentIntent or SetupIntent. Stripe-generated child objects are matched through
their parent: a card's Customer, or a refund/dispute's Charge and PaymentIntent.
Imported customers must be tagged with this gym before using this adapter; email
matches are restricted to tagged customers and ambiguity fails closed. The saved
method is returned explicitly; a Checkout success never implies a Customer default.

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
that an event belongs elsewhere. `Payments` and `FakePayments` exports are unchanged;
the fake does not yet produce these error codes.

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
objects. Provider/network errors still fail the pass. `readPaymentObject` and
`findCharge` return `unknown` for objects that are missing or not this gym's.
Do not use search to decide whether a charge happened.

`stripeTransport` puts GET filters in the URL: the SDK's `rawRequest` accepts
parameters as a body only for POST. Read filters retain Stripe's bracket notation
for creation bounds and pagination.

`stripeProvisioner` probes the complete restricted-key profile with reads and
nonexistent-ID write probes; it never creates payments to test permissions. Webhook
registration proves Webhook Endpoints Write and returns the endpoint-specific
secret. Credentials and that secret are stored together, encrypted as `stripe_config`.
Retries use a deterministic endpoint key. If saving loses the revision race, no
credentials activate; an unreferenced endpoint can remain for operator review.

## Offline contracts and recording

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
foreign gyms, permission failures, and transaction guards. Database authorization,
encryption, audit and revision-race tests are in `areas/setup/stripe-step.test.ts`.

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

**Unverified:** real HTTPS webhook delivery (deployment stage 2), actual inbox
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
| Payment Methods | Read |
| Charges and Refunds | Write |
| Webhook Endpoints | Write |
| Events | Read |
| Disputes | Read |
| Everything else | None |

Prepare a test Customer tagged with the contract gym ID and four attached saved
PaymentMethods. Use test card 4242 (success), 0341 (saved-card decline), 3155 (finish its
on-session Checkout/SCA setup first), and 3184 (off-session still needs SCA).
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
the permission checks. The harness requires `rk_test_` and a test-only transport;
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
adapter or null. No credentials or SDK types cross the frozen interface.

The registered web `StripeStep` is phone-first, masks its key, shows all required
permissions, and clears the key on success or failure. The wizard shell must
render `setupSteps.setup.stripe` at step 6 and refresh status when it advances.
Its feature-local English fallback can move into `locales/en/setup/stripe-step.json`
at integration without changing the keys.

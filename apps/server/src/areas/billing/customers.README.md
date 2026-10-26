<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Household Stripe customers

`createCustomersService({ paymentsFor, scope?, clock? }).ensureCustomer(gymId,
householdId)` returns the household's stored customer ID or creates and links one.
Signed-link Checkout calls it for payment, card updates and onboarding. Existing
and imported IDs stay unchanged; email matching is not part of this service.

The service first reads the household in a short gym-scoped transaction. Existing
IDs return immediately, even without configured Stripe or payer details. Missing
email or a blank name fails without reserving. It resolves the provider outside
the transaction, then locks and re-reads the household in a second transaction.
Only then does it write a `billing.customer.creation_reserved` audit before
calling `createCustomer` outside the transaction. The key is
`household:<household UUID>:customer`. The reservation
stores a SHA-256 digest of the exact request, keeping names and emails out of the
append-only audit log. Concurrent callers use identical parameters and the same
provider key. A final short transaction locks the household, saves the returned
ID only while `stripe_customer_id` is null, increments its revision and writes
`billing.customer.linked`. A concurrently imported ID wins.

A lost response or failed database save retries the reserved request for at most
23 hours. The reservation is never renewed: Stripe can discard idempotency keys
after 24 hours, and creating again could duplicate an existing customer. If the
reservation expires or the name/email changes while creation is unresolved, the
service refuses another create request. Gym staff must reconcile the original
customer before linking an existing ID through the people import. An empty
Stripe search result is never proof that creation failed.

Only the typed in-flight idempotency conflict is retried automatically, with at
most three backoffs of 100, 250 and 500 ms and a 2.5-second retry scheduling budget.
Every attempt rechecks the reservation's deadline. Other failures, including
HTTP 400 responses, retain the reservation: a status code alone does not prove
that no concurrent request created a customer. Staff reconcile these requests
with Stripe rather than renewing the reservation or using a different key.

The adapter tags new customers with `gym_id` and `household_id`, validates the
returned ownership, and rejects provider calls inside database transactions.
Stripe not configured, missing household email and unresolved creation retain
the signed-link page's translated contact-the-gym state. No new public route or
member data access is introduced. Checkout logs one JSON line to stderr through
its injectable `log` option before returning the friendly state. The line includes
`gymId`, `householdId`, purpose and reason; sanitized error names, stack frames
and causes preserve diagnostics without logging messages, names, email or secrets.

| Reason | Staff action |
| --- | --- |
| `stripe_not_configured` | Check the gym's Stripe configuration and the sanitized cause. Fix configuration and reopen the link; failed provider resolution writes no reservation. |
| `missing_details` | Add the household email and a nonblank name, then reopen the link. No reservation is written for missing details. |
| `creation_expired` | Reconcile the reserved request in Stripe using the household ID/key and link the confirmed existing customer through the people import. Never create again blindly or delete the reservation. |
| `details_changed` | Reconcile the original request before linking an existing customer. If retrying within 23 hours, restore its exact original details only after checking the provider request. |

Unexpected failures log the error name instead of a reason, with a sanitized
cause chain. Investigate provider or database availability and retry the same
request within the reservation window; an unresolved expiry needs reconciliation.

Payment Checkout saves the card only for cycle invoices and assignment invoices
(nonempty lines containing only membership, sign-up fee, discount and tax), using
the runner's shared predicate. Other one-off payments do not save a card or change
the household's default. Card and onboarding links use setup mode and save cards.
Returned and reused sessions must match the expected card-saving policy.
The existing `checkout.session.completed` webhook handler persists the card and
records the payment; the next daily charge run uses that stored card explicitly.
No additional runtime registration is required: the existing
`createSignedLinkCheckout({ paymentsFor, originFor, clock })` composition constructs
the customers service internally.

`customers.test.ts` covers reservations, concurrency, restarts, retention expiry,
changed details, import races and gym isolation against PostgreSQL.
`customers.links.test.ts` creates a household through the admin API and exercises
the registered signed-link routes, webhook replay, card setup, onboarding and
next-cycle collection. The payments contract runs creation against the fake,
synthetic Stripe API and serialized transport replay.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal billing reads and payment actions

Every read reloads the login's household grant and uses `forHousehold`. Answers
name the current household and use `Cache-Control: no-store`.

| Route | Access and response |
| --- | --- |
| `GET /api/portal/credits` | `profile.read`: payers see household members with usable credits; adult non-payers see only their own. Returns member ID, first and last name, positive balance and soonest expiry, with no ledger, sale, invoice or money fields. |
| `GET /api/portal/invoices` | `billing.manage` (payers): issued invoices, filtered and paged; no drafts. |
| `GET /api/portal/invoices/{invoiceId}` | Payers: one household invoice and its lines. |
| `GET /api/portal/invoices/{invoiceId}/receipt` | Payers: a short-lived receipt download for a paid invoice. |
| `GET /api/portal/payment-methods` | Payers: masked, current saved cards. |

Credit balances sum only positive lot remainders with no expiry or an expiry
strictly after the injected clock's current instant, matching `usableLots` even
before the expiry job runs. The soonest expiry ignores permanent lots unless
every usable lot is permanent, when it is null. Exhausted or expired members are
absent from the answer, and so are erased members, whose lots remain; no credits
returns an empty array. Signed links cannot
read credit balances.

Payers can start Stripe Checkout with
`POST /api/portal/invoices/{invoiceId}/checkout` or
`POST /api/portal/payment-methods/checkout`. Those actions require the open
household header and the existing signed-link Checkout runtime configuration.
Credit reads require no additional runtime wiring and offer no purchase or
adjustment action.

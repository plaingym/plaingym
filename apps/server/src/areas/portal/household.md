<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal household, billing and waivers

These portal routes act for the household chosen with the session
(`auth.md`). No request body, query or parameter selects a household. Each route
declares its member permission, `createPortalAuthorization` reloads the login's
role, and every read goes through `forHousehold` with the user's identity, so a
revoked login or a resource outside the household returns not found.

Within a household, the payer sees every current member, the household's contact
details, invoices, receipts and saved cards. An adult who is not the payer sees
only their own profile, memberships and waivers; every other route answers 404
for them, as it does for other households, other gyms, staff and devices.

## Household and profiles

`household.ts` serves the household (`GET /api/portal/household`), its current
members (`GET /api/portal/members`), one profile and that member's memberships.
Payers may edit the household's name, email, phone and address, their own
profile and children's profiles. `payerMayActFor` decides whom a payer acts for,
for profile edits and waiver signing alike: their own member, and members whose
recorded date of birth makes them under 18 in the gym's timezone. An unknown date
of birth proves nothing, so such a member is refused, as is any other adult; a
payer's edit to one returns 403. Member-only logins need a recorded adult date of
birth, so an adult with their own login is always refused. Edits run through the members
service, which checks the revision, refuses erased profiles and writes the audit
event with the member's user ID.

Membership state, the billing day, family discount, status, email preferences,
medical notes and check-in credentials are not editable here: the request
schemas reject those fields and no portal route changes a membership. Photos are
managed by the gym; an update may only repeat the current photo key.

A contact saved by staff without a relationship is shown as `-`, because the
portal contract requires a relationship; saving `-` stores no relationship.

## Billing

Only the payer reaches `/api/portal/invoices*` and `/api/portal/payment-methods*`.
Lists exclude drafts and revoked cards.

Paying an open or past-due invoice and updating the card reuse the signed-link
Checkout (`areas/billing/signed-link-checkout.ts`). The route mints a single-use
`pay_invoice` or `update_card` link for the household, created by the payer and
valid for a day, and starts that link's Checkout. The token never appears in a
response body or in the Stripe return URL. It is sealed into the same HttpOnly
receipt cookie that `/l/*` uses, so Stripe's return to `/l/return` reopens the
link's page, which confirms the result and can recover a missed card webhook. If
Checkout cannot start, the link is revoked. Once a new Checkout starts, the
login's earlier unused links for the same purpose (and invoice) are revoked, so
only the newest stays usable; a payment or card completed in an older Checkout
is still recorded from the webhook. Customer creation, the card-saving
rule for cycle and assignment invoices, Checkout reuse and expiry, and webhook
completion are the signed-link behavior (`public/links/README.md`). Invoice state
changes only when the webhook or a verified return records the payment through
the invoice transitions; cards are written by the shared idempotent card writer.

`GET /api/portal/invoices/{invoiceId}/receipt` renders a PDF receipt for a paid,
partially refunded or refunded invoice and returns a five-minute link. It names the
gym, the invoice number, the payment date in the gym's timezone, each line and the
total, and marks a refunded invoice with its status. The household invoice queries
don't expose refund amounts, so the receipt doesn't show one. Gyms have no locale
setting, so money and dates use English formatting, as the signed-link pages do. The PDF is
stored under `<gymId>/receipts/` and marked deleted at once, like waiver PDFs, so
the upload sweep removes it. Demo sandboxes refuse general uploads, so receipts
answer 503 (unavailable) there.

## Waivers

The self routes (`/api/portal/waivers*`) cover the login's own member; the
household routes (`/api/portal/household/waivers*`) list every current member
and need the payer. The payer signs for themselves and, as guardian, for
children (`payerMayActFor`); anyone else, including a member with no recorded date
of birth, signs from their own login or at the gym, so a payer's upload or
signature for them returns 403. The waiver service's own guardian rule is
unchanged: a member with no recorded date of birth signs as a guardian, even from
their own login. Each lists pending documents (the latest version of each
family that is not retired and not yet signed by that member) and signed copies,
uploads a signature image, signs, and returns a signed PDF link.

Signed lists and pending documents read whole signature rows through
`forHousehold`, whose waiver query has no narrower projection. Uploads and
signatures check the member against the household first, then call
the waiver service, which validates the image, the current template version and
the guardian rule and stores one immutable snapshot. A replay with the same image
returns the stored signature; changed details are refused.

## Runtime

`configurePortalBilling({ checkout, receiptKey, uploadsFor })` takes the runtime's
signed-link Checkout, the signed-link receipt key and the gym's file storage.
`configurePortalWaivers(waivers)` takes the configured waiver service. The
household routes need no configuration.

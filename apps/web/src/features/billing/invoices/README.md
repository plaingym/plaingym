<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Invoice screens

The invoice page and detail route use the shared page/state components. Lists and
line items use stacked rows; editors, confirmations, and receipts use the shared
`Dialog`. No new shared components are needed.

The registered member profile tab resolves the member's household and requests
that household's invoices. Cache keys include gym, household/member, filters and
pagination. A created one-off invoice opens its detail so staff can choose cash or
check, the saved card, or a signed pay link. Currency comes from gym settings;
decimal input converts to integer cents without floating-point rounding.

Collection controls use `payments.record`, pay links use `links.send`, and refund
and review-release controls use `refunds.create`. Server routes enforce the same permissions. A
failed charge reports that the invoice remains open; unresolved outcomes tell
staff to check the invoice before collecting another payment. Save errors stay in
the open dialog, preserving the staff member's draft.
The error envelope's `details.reason` selects a translated payment message.
Pending attempts tell staff that the payment is still being resolved and to
check back shortly. Card charging is disabled on a review hold or without an
active default card, including when card loading fails. Card lookup covers all
pages. The refund dialog displays the remaining amount after pending and
successful refunds, and uses that amount as its initial input.

Receipt view reads the stored invoice lines, payments and refunds. Pay links use
the signed-link contracts directly, and are bound to one invoice and household.
No Stripe Checkout response is fabricated for a signed link.

`page.test.tsx` covers contract transport, household filtering, pagination, exact
cents, front-desk controls, admin refunds, error recovery, and signed-link sends.
Phone and desktop browser checks should cover the list, one-off editor, detail,
cash/check dialog, charge confirmation, pay link, receipt, refund, card removal,
review hold/release, pending payment errors, and member invoice tab at 360 px and desktop width, including axe A/AA, 44 px
controls, and absence of horizontal page scrolling.

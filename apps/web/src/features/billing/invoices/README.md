<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Invoice screens

The invoice page and detail route use the shared page/state components. Lists and
line items use stacked rows. One-off editors use the shared `Dialog` and searchable
household `Autocomplete`. Receipt, cash/check, saved-card confirmation, refund,
pay-link, review-hold and card-management views stay inside invoice details,
with a back control and focus restored to the action that opened the view.

In the Packs tab, a successful manual payment, saved-card charge or refund starts
a minute of follow-up credit reads. The invoice action invalidates billing once;
the follow-up callback only sets that read window. Failed or pending processor
answers do not start it. Releasing a hold or sending a pay link may settle much
later; use Refresh credits after those actions to read the latest balance.

The registered member profile tab resolves the member's household and requests
that household's invoices. Cache keys include gym, household/member, filters and
pagination. A created one-off invoice opens its detail so staff can choose cash or
check, the saved card, or a signed pay link. Currency comes from the bootstrap gym summary;
a typed amount converts to the currency's minor units with `parseMinorUnits` from
`@plaingym/shared/money`, without floating-point rounding. A card refund takes only whole steps
of the currency, as Stripe does (no 1.255 KWD); a cash or check refund takes any minor unit.

The one-off editor offers a custom amount only with `payments.custom` (owner, admin);
without it, staff pick a catalog charge type. When the gym has no active charge type, the editor says so: staff with `plans.manage` (the right to add a charge type; owners and admins) are told to add one in the billing catalog, with `or use a custom amount` when they can bill one, and other staff are told to ask an owner or admin (adding `or use a custom amount` when they can bill one). Collection controls use `payments.record`, pay links use `links.send`, and refund
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
A sent record with `revokedAt` displays confirmation that manual-payment instructions
were sent. A zero invoice offers no send/share pay-link action. No Stripe Checkout
response is fabricated for a signed link.

`page.test.tsx` covers contract transport, household filtering, pagination, exact
cents, front-desk controls, admin refunds, error recovery, and signed-link sends.
Phone and desktop browser checks should cover the list, one-off editor, detail,
cash/check dialog, charge confirmation, pay link, receipt, refund, card removal,
review hold/release, pending payment errors, and member invoice tab at 360 px and desktop width, including axe A/AA, 44 px
controls, and absence of horizontal page scrolling.

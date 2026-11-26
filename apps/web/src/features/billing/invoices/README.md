<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Invoice screens

The invoice page and detail route use the shared page/state components. Lists and
line items use stacked rows. One-off editors use the shared `Dialog` and searchable
household `Autocomplete`. Receipt, cash/check, saved payment method confirmation, refund,
pay-link, void and review-hold views stay inside invoice details,
with a back control and focus restored to the action that opened the view.

Household billing and invoice details share `CardList` for payment methods and
their confirmations. Household billing is available before an invoice exists. Staff with
`payments.record` can choose **Import cards from Stripe** there or in invoice
details. The action queues bounded jobs and offers **Refresh payment methods** to read their
results. The household page has one import control, including when an invoice
dialog is open. Refresh invalidates only this household's method lists and charge
eligibility. Default and removal actions require `payments.record`, and refresh
these queries on success and error because local removal can precede a Stripe outage.
Card rows show the network, last four digits and the expiry in MM/YYYY when both
parts are available. Bank rows show the bank name when available and the
account's last four digits. Revoked rows show **Removed from Stripe** once a
detach is recorded (`removal: 'finished'`), **Removal pending** with **Retry
payment method removal** while a staff removal or erasure detach is still
outstanding (`removal: 'pending'`), and **Removed** with no retry button when
no Stripe detach was queued (a bank method revoked after failed debits or a
test card cleared on a switch to live). Removal help identifies
the method, and promotion help appears only for the current active default,
including after a failed removal refresh.

Imports preserve the selected default and never restore a removed card. When a
default needs replacing, import, removal and test-card clearing share the newest-first
order: processor creation time when known (local time otherwise), then local
creation time and row ID. They skip expired cards using the gym's local month,
falling back to the newest if every card has expired. Unknown expiry stays eligible.
Imports audit stale ownership refusals, skip cards stored for another household,
and restart refused cursors at most three times before settling a partial import.
The linked Stripe customer must already be tagged for this gym; conflicting
household metadata is refused. The campaign's card filter uses stored cards.

In the Packs tab, a successful manual payment, saved payment method charge or refund starts
a minute of follow-up credit reads. The invoice action invalidates billing once;
the follow-up callback only sets that read window. Failed or pending processor
answers do not start it. Releasing a hold or sending a pay link may settle much
later; use Refresh credits after those actions to read the latest balance.

The invoice list and detail show a muted **Processing** badge for processing
invoices. Select **Processing** in the invoice list's **Status** filter to show
only processing invoices.

The registered member profile tab resolves the member's household and requests
that household's invoices. Cache keys include gym, household/member, filters and
pagination. A created one-off invoice opens its detail so staff can record cash or
check, select **Charge saved payment method**, or send a signed pay link. Currency
comes from the bootstrap gym summary. A typed amount converts to minor units with `parseMinorUnits` from
`@plaingym/shared/money`, without floating-point rounding. A card refund takes only whole steps
of the currency, as Stripe does (no 1.255 KWD); a cash or check refund takes any minor unit.

The one-off editor offers a custom amount only with `payments.custom` (owner, admin);
without it, staff pick a catalog charge type. When the gym has no active charge type, the editor says so: staff with `plans.manage` (the right to add a charge type; owners and admins) are told to add one in the billing catalog, with `or use a custom amount` when they can bill one, and other staff are told to ask an owner or admin (adding `or use a custom amount` when they can bill one). Collection controls use `payments.record`, pay links use `links.send`, and refund,
void and review-release controls use `refunds.create`. Voiding an open or past-due
invoice requires a reason and explains that dunning, retries and pay links stop,
while memberships and future invoices stay as they are. Pending card or Checkout
payments must be resolved first. A processing invoice offers the same staff
**Stop waiting for this bank debit**: the server checks Stripe first and makes the
invoice collectible again only when the flagged debit failed or was cancelled;
a refusal (debit still open, paid, processing or not flagged, or Stripe
unreachable or with no record of the debit) shows its reason in the form. Server routes enforce the same permissions. A
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
A sent record displays confirmation of manual-payment instructions when the invoice
amount fails the shared card minimum or currency-step check. A card-payable send
replay still says a pay link was sent if its credential has since been revoked.
A zero invoice offers no send/share pay-link action. No Stripe Checkout
response is fabricated for a signed link.

The existing pay-link dialog also offers Send by text for the billing phone and
each household member. Choices without notices consent, a valid phone, or an
unerased member are disabled with the reason. Household members load across all
pages. Text sends include `channel: 'sms'` and a member recipient when selected;
the billing phone omits that recipient. Retry generations include the delivery
choice, so changing recipient cannot replay another recipient's send. Uncertain
sends show the same deliberate Send again confirmation for either channel.

`page.test.tsx` covers contract transport, household filtering, pagination, exact
cents, front-desk controls, admin refunds, error recovery, and signed-link sends.
Phone and desktop browser checks should cover the list, one-off editor, detail,
cash/check dialog, charge confirmation, pay link, receipt, refund, card removal,
review hold/release, pending payment errors, and member invoice tab at 360 px and desktop width, including axe A/AA, 44 px
controls, and absence of horizontal page scrolling.

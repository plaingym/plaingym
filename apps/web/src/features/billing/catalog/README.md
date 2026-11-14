<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing catalog

Plans, tax rates and charge types are created and edited in a dialog. Save
failures and revision reloads stay in that dialog. A plan price change replaces
the editor with its review dialog, and cancelling that review returns to the draft.

Changing a plan's price with current memberships opens **Change plan price**.
**New members only** saves only the plan; **All existing members** also moves
frozen memberships, leaving commitments and custom prices out until **Include
commitments and custom prices too** is checked. **Choose members** starts with
the preview's default ticks; exceptional memberships can be selected explicitly,
while memberships with a scheduled change or incompatible terms show why they
cannot move. Search and status, commitment and custom-price filters affect only
the visible list, never the selection. Phones show cards; desktop tables scroll
inside their own container. A truncated preview disables All.

Changing the price together with the billing interval or currency offers only **New members only**,
with an explanation that existing memberships retain their current terms and price.

The effective date starts 30 days ahead in the gym's timezone. A changed date
requires a fresh preview. Email is checked by default and disabled with its
reason when member email cannot be sent. Review counts selected memberships and
distinct households, separating reachable payers, missing addresses, erased
payers and suppressed addresses (opted out or undeliverable). Staff must tell
unreachable households another way. An increase with fewer than 30 days' notice
or no email requires explicit confirmation; a decrease does not.

Other plan edits save first while keeping the old price; price-only moves skip that save.
The price-change apply uses the current revision or the revision returned by a needed save.
When a failed save already committed, re-reading matching intended fields recovers its revision.
A failed apply keeps the exact request,
including its key and membership revisions, for retry, and offers reloading the
plan as the way out. Conflicts require reloading and reviewing the plan. The result names scheduled and skipped memberships and
their reasons, and reports reachable households with a notice queued separately
from those that cannot be emailed. Delivery is rechecked by the notice job.

The **Discounts** section is available only to owners and admins, alongside class
packs on the plans page. It uses cards at phone and desktop widths, shows price
and signup-fee benefits, duration, uses, code, eligible plans and the end date,
and optionally includes inactive discounts. Create or edit a discount to change
its name, optional code, limits, eligible plans and active state. Clearing
**Active** turns it off for new applications; existing memberships keep their
applied terms. Monetary fields use the discount's currency and minor units.

Price benefits can be a percentage or fixed amount, once, for a number of billing
cycles, or every cycle. A discount can also waive the signup fee, alone or with a
price benefit. Empty plan selection means every plan. Terms are disabled when
the catalog reports `termsLocked`, including after all historical uses
have been released. Any edit conflict blocks saving until staff close and reload,
and explains that changing used terms requires a new discount.

The **Class packs** section lists active packs, with an option to include archived
packs. Its dialog creates and edits the name, price, tax rates, 1–100 credits and
optional 1–3650 expiry days. Clearing **Active** archives a pack; checking it
restores it. A stale revision blocks saving until staff close, reload and reopen
the editor. Currency and inactive-tax refusals show their own messages and leave
Save available. It uses the pack's existing currency when editing. The gym's currency
cannot change once any class pack exists, including an archived pack.

The member profile's **Packs** tab requires `billing.read`. It shows the available
balance, remaining lots with expiry in the gym's timezone, and paged credit history
newest first. **Sell a pack** and **Adjust credits** require `payments.record`.
Selling opens the existing invoice dialog, whose collection and refund actions
keep their existing permissions. A sale adds credits only once paid. Adjustments
require a reason; unchanged retries reuse the adjustment ID and server refusals
stay inside the form. A sale, collection or refund refreshes the credit
balance, then checks every two seconds for one minute so delayed effects appear.
Viewing and closing an unchanged invoice starts no follow-up reads. The
**Refresh credits** action also reloads the balance and current history page.

Credit history supplies invoice IDs beside their display numbers. Clicking an
invoice opens the existing dialog directly, without searching household invoices.
The catalog and sale form share one cached pack list.

The catalog edits plans, charge types and tax rates with the revision read when
the editor opened, and only a reload moves an open editor to a newer revision. A
save conflict on an existing record refreshes the catalog and offers **Reload
record**. Save stays disabled until that reload succeeds. Reload keeps edited
fields, fills untouched fields from the latest record and uses its revision for
the next save. When staff and the latest record both changed a field, its latest
value appears beside the retained draft for review. Equivalent parsed amounts, sign-up fees and
tax rates do not show a clash just because their decimal formatting differs. Saves use that controlled
draft. Tax selections merge rate by rate: the draft's own ticks and
unticks apply to the latest list, and rates that no longer apply are removed.
Staff can keep editing the draft while deciding to reload, and review it before
saving. A failed reload keeps the draft and can be retried; a record missing
from the catalog keeps its draft visible but cannot be saved. A conflict on a
new record refreshes the catalog and leaves Save available, because there is no
record to reload.

Removing inactive tax rates from a plan or charge type uses the revision shown
in the list, so a conflict there refreshes the list for the retry.

Archiving an attached tax rate first lists its charge types, class packs and plans and asks
staff to confirm removing it from them. An attachment conflict opens that
confirmation; other conflicts use the reload flow. An archive confirmation that
hits a revision conflict closes and refreshes the catalog, offering reload when
the editor is still open.

The catalog and invoice transports use `readApiError` from `lib/api.ts` to
read structured reason codes. User messages come from locale keys; arbitrary
server messages are never displayed. Price-change apply also displays bounded messages for
expected client refusals, such as an effective date that has passed; server errors stay generic.

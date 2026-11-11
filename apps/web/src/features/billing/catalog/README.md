<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing catalog

The **Class packs** section lists active packs, with an option to include archived
packs. Its dialog creates and edits the name, price, tax rates, 1–100 credits and
optional 1–3650 expiry days. Clearing **Active** archives a pack; checking it
restores it. A stale revision blocks saving until staff close, reload and reopen
the editor. It uses the pack's existing currency when editing.

The member profile's **Packs** tab requires `billing.read`. It shows the available
balance, remaining lots with expiry in the gym's timezone, and paged credit history
newest first. **Sell a pack** and **Adjust credits** require `payments.record`.
Selling opens the existing invoice dialog, whose collection and refund actions
keep their existing permissions. A sale adds credits only once paid. Adjustments
require a reason; unchanged retries reuse the adjustment ID and server refusals
stay inside the form. Closing an invoice refreshes the credit balance, then checks
every two seconds for one minute so delayed payment/refund effects appear. The
**Refresh credits** action also reloads the balance and current history page.

Credit history supplies invoice numbers rather than IDs. Clicking an invoice
resolves its number through the member's household invoice pages, then opens the
existing invoice dialog. No other household's invoices are requested.

The catalog edits plans, charge types and tax rates with the revision read when
the editor opened, and only a reload moves an open editor to a newer revision. A
save conflict on an existing record refreshes the catalog and offers **Reload
record**. Save stays disabled until that reload succeeds. Reload keeps edited
fields, fills untouched fields from the latest record and uses its revision for
the next save. Tax selections merge rate by rate: the draft's own ticks and
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

The catalog and invoice transports use `apiErrorReasons` from `lib/api.ts` to
read structured reason codes. User messages come from locale keys; arbitrary
server messages are never displayed.

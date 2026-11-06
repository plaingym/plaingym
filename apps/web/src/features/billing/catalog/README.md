<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Billing catalog

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

Archiving an attached tax rate first lists its charge types and plans and asks
staff to confirm removing it from them. An attachment conflict opens that
confirmation; other conflicts use the reload flow. An archive confirmation that
hits a revision conflict closes and refreshes the catalog, offering reload when
the editor is still open.

The catalog and invoice transports use `apiErrorReasons` from `lib/api.ts` to
read structured reason codes. User messages come from locale keys; arbitrary
server messages are never displayed.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal billing, waivers and household pages

Invoices below the card minimum or off the currency step show manual-payment
instructions instead of a Pay now action. The server repeats the shared money check
before creating a pay link or Checkout; amounts are never silently rounded.
An open zero invoice shows a note that no payment is needed, without a payment action
or manual instructions, and Checkout is refused before minting a link.

`/portal/billing` shows read-only class credit balances for members with usable
credits. Payers see each member of their household; an adult non-payer sees only
their own balance. Each card shows the total classes left and the soonest expiry
in the gym's timezone. The expiry says **Next credits expire: use by** the last
usable local day (one millisecond before exclusive expiry), so it does not suggest
that the whole balance expires together. Expired and used-up lots do not count. A payer's page
leaves the card out when nobody visible has credits; an adult non-payer's page
says they have none. The portal sells no class packs.

For payers, the same page lists invoices with their lines, starts Stripe Checkout
to pay an open or past-due invoice or to update the card, and prepares receipt
downloads for paid invoices. The page never collects card details.

`/portal/waivers` shows documents waiting for a signature and signed copies with
PDF downloads. Payers see every current household member and sign for children
as their parent or guardian; an adult member sees only their own documents.

`/portal/household` lets payers edit the household's contact details, their own
profile and children's profiles, and shows each member's memberships read-only.
An adult member sees their own profile and can give or withdraw their own notices
and announcements SMS consent through `sms_consent.manage`. Payers can do the same
for themselves and children they manage, but cannot consent for another adult.
Billing-phone notices consent stays payer-only under `household.manage`.
Payers save a changed billing phone before agreeing to notices and can withdraw
an existing consent while the phone has unsaved edits. Both billing-phone consent
actions are disabled during a household contact save or a discard refresh.
Contact Save and Discard edits are disabled while a billing-phone consent
change and its refresh are pending.
Each member's SMS consent controls and that member's editor share one pending
flag. While either request and its refresh are pending, the other control is
disabled and sends nothing; after a failure both are available again. The flag
is per member, so another member's card and editor stay available. Saves still
send the member revision from the latest read.
Household and member saves send only changed fields. An unrelated edit preserves
stored address and emergency-contact keys that the running release cannot read;
editing either of those fields replaces that entire value.
After a household contact save and refetch, edits made during the request remain
in the form. A newer edit to a submitted field can be saved against the refreshed
revision when the refetch confirms the submitted value. A concurrent change to
that field still triggers a conflict. Payers can choose **Discard edits** after a
contact conflict to load the latest stored contact details and revision. If the
refresh fails, the form shows the failure alongside the conflict and keeps the
draft and Discard edits available for a retry.
Saves with no changes send no request and do not refetch: the household form says
"Nothing changed." and the member editor closes.

Each page reads the open household once, with `usePortalScope` (or `usePortalMembers`,
which also loads the members a login may act for), and builds every query key from its
key, which includes the open household, so one household's cached pages can't be reached
from another's. Pages that need the login's role share one context query
(`usePortalContext`); billing waits for this role before showing its credit or payer
sections and description. A failed first context read shows only its retry state. Every portal answer names the household the server read it for;
`PortalScope.own` passes on only an answer for the page's own household. An answer for
another one (the session moved on, say because another tab switched) is never stored or
shown: the page shows loading while the household lists are read again, after which
every key is the other household's. Writes and member-ID reads send `X-Portal-Household` from that same
page key. A household conflict (409 with that response header) starts the same
recovery; a revision conflict stays with the form. Portal 404s refresh the lists in the background without hiding the page,
including when a revoked link leaves several households to choose from. Recovery
keeps first reads (context, act-for members and inner page sections) loading until those lists settle, without hiding cached content.
Only a recovery-triggered refresh delays those failures; ordinary focus and reconnect list fetches do not.
The 404 refresh marker is shared in the login's query cache per household, so a
refresh started by the shell or another scope also keeps a page's first failure loading.
Recovery shares in-flight reads for the request's list version, sampled when the request starts. A later 404 always reads again after recovery settles. If
a joined read predates the move or does not name the household returned by the
conflict, recovery reads again. A second mismatch fails rather than looping.
During a confirmed mismatch, portal pages hide their content without collapsing the page or unmounting forms
or dialogs. Dialogs close themselves during recovery (including ones mounted while it is running), then reopen with their own focus and scroll restored if recovery fails. Recovery never rewinds window or page scrolling.
Typed drafts and drawn signatures remain. Every read shows its own failure, except those a page keeps showing from its cache (the context, the act-for members and the household details): when a refetch of one fails, `PortalRecovery` shows a sticky failure inside an open dialog, or inside the page's width when no dialog is open. Its retry reads only those again. After
a move the shell resets the page and asks the person to review the household and
any unfinished work. The notice clears on dismissal, navigation, or a deliberate
household switch; late answers from that switch do not show it again.
The notice is accurate for moves discovered by reads as well as writes;
the old household's draft and action error do not appear in the new household.
Client answer parsing strips
new, unknown fields recursively while still requiring and validating known fields. `household/keys.test.ts` checks that every page key starts from
the scope's key and stays out of the shell's reserved `shell` segment.
The server is authoritative for every permission; the pages only hide actions a
login cannot use.

After `pnpm build` and installing the pinned `e2e/`
dependencies, run from the repository root:

```sh
node apps/server/node_modules/tsx/dist/cli.mjs apps/web/src/features/portal/household/tests/browser-check.ts
```

The check serves the built portal with API fixtures in headless Edge and opens
each page as a payer and as an adult member at 360 px and 1280 px, including the
signing and edit dialogs and the phone menu. It checks horizontal overflow, 44 px
touch targets and axe A/AA, and saves screenshots under
`coverage/portal/household-browser`.

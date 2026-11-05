<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal billing, waivers and household pages

Invoices below the card minimum or off the currency step show manual-payment
instructions instead of a Pay now action. The server repeats the shared money check
before creating a pay link or Checkout; amounts are never silently rounded.

`/portal/billing` (payers) lists invoices with their lines, starts Stripe Checkout
to pay an open or past-due invoice or to update the card, and prepares receipt
downloads for paid invoices. The page never collects card details.

`/portal/waivers` shows documents waiting for a signature and signed copies with
PDF downloads. Payers see every current household member and sign for children
as their parent or guardian; an adult member sees only their own documents.

`/portal/household` lets payers edit the household's contact details, their own
profile and children's profiles, and shows each member's memberships read-only.
An adult member sees their own profile, read-only.

Each page reads the open household once, with `usePortalScope` (or `usePortalMembers`,
which also loads the members a login may act for), and builds every query key from its
key, which includes the open household, so one household's cached pages can't be reached
from another's. Pages that need the login's role share one context query
(`usePortalContext`). Every portal answer names the household the server read it for;
`PortalScope.own` passes on only an answer for the page's own household. An answer for
another one (the session moved on, say because another tab switched) is never stored or
shown: the page shows loading while the household lists are read again, after which
every key is the other household's. Writes and member-ID reads send `X-Portal-Household` from that same
page key. A household conflict (409 with that response header) starts the same
recovery; a revision conflict stays with the form. Recovery shares an in-flight
or just-finished list read across the page's queries. Client answer parsing strips
new, unknown fields recursively while still requiring and validating known fields. `household/keys.test.ts` checks that every page key starts from
the scope's key and stays out of the shell's reserved `shell` segment.
The server is authoritative for every permission; the pages only hide actions a
login cannot use.

After `pnpm build` (with `SOURCE_URL` set) and installing the pinned `e2e/`
dependencies, run from the repository root:

```sh
node apps/server/node_modules/tsx/dist/cli.mjs apps/web/src/features/portal/household/tests/browser-check.ts
```

The check serves the built portal with API fixtures in headless Edge and opens
each page as a payer and as an adult member at 360 px and 1280 px, including the
signing and edit dialogs and the phone menu. It checks horizontal overflow, 44 px
touch targets and axe A/AA, and saves screenshots under
`coverage/portal/household-browser`.

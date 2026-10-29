<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal billing, waivers and household pages

`/portal/billing` (payers) lists invoices with their lines, starts Stripe Checkout
to pay an open or past-due invoice or to update the card, and prepares receipt
downloads for paid invoices. The page never collects card details.

`/portal/waivers` shows documents waiting for a signature and signed copies with
PDF downloads. Payers see every current household member and sign for children
as their parent or guardian; an adult member sees only their own documents.

`/portal/household` lets payers edit the household's contact details, their own
profile and children's profiles, and shows each member's memberships read-only.
An adult member sees their own profile, read-only.

Queries live under the `portal` cache key, so switching household discards them.
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

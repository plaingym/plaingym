<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal schedule, check-in and progress pages

Three portal pages register in `portalNav` and mount at `/portal/schedule`,
`/portal/checkin` and `/portal/progress`. Each reads the login's role from
`/api/portal/context` and the members it may act for from
`/api/portal/schedule/members`; a picker appears only when there is more than one.
The server decides every permission; the pages only choose which allowed path to
call (the payer uses the household-member booking paths, an adult member the
self paths).

The schedule shows one gym-local week at a time, starting on Monday. It displays
seven day columns from the `lg` breakpoint and a list of days with classes on
phones. Each class card shows the time, name and one status badge for the
selected member. Open the card to see household places and booking actions. A class offers
Book or Join the waitlist once its booking window opens, and Cancel or Leave the
waitlist only until its `cancelBefore` instant; after that it says the cutoff has
passed. A full class stops offering Join the waitlist after that instant; a free
place still offers Book. An open page updates these actions with one timeout for
the nearest cutoff, booking opening, session start or week rollover. It also
refreshes on window focus or when the page becomes visible again.
The schedule is read again after every booking or cancellation. A coded refusal
from the booking service shows the service's message, any other conflict shows a
general one, and any other failure says the booking or cancellation could not be
confirmed. Household members' places appear with their names. Class and member
names wrap, even with no break opportunity, rather than truncating or widening the page at 360 px.

The check-in page renders the member's code as a QR image in the browser, shows a
"no active code" state with a create action, and asks for confirmation before
replacing a code. Codes are never cached between visits.

The progress page shows the current rank and next step per program with the
shared criterion progress bars, the promotion history and paged attendance.

After `pnpm build` and installing the pinned `e2e/`
dependencies, run from the repository root:

```sh
node apps/server/node_modules/tsx/dist/cli.mjs apps/web/src/features/portal/schedule/tests/browser-check.ts
```

It serves the built app with fixture API replies, uses headless Edge (or
`E2E_BROWSER_CHANNEL`) at 360 px and 1280 px, books, waitlists and cancels for a
child in the class dialog, creates and replaces a check-in code, pages attendance, and checks
overflow, 44 px touch targets and axe WCAG A/AA. Screenshots are saved under
`coverage/portal/schedule-browser`.

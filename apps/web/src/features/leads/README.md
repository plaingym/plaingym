<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Leads

`/admin/leads` registers through `leads.manage`: owners, admins and front desk
see it; coaches don't, and opening the address as a coach shows a notice
without calling the API. The server enforces the same permission on every
`/api/leads` route.

One section per open stage (new, contacted, trial booked, trial attended), each
with its own total and its own pages of 25 ("Show more"), so a long stage never
hides another. Sections stack on phones, two across on tablets and four across
on wide screens. Lost leads stay hidden until **Show lost** adds a Lost
section. The source filter and **Follow-up due** (due today or earlier in the
gym's time zone, open leads only) apply to every section.

Each lead shows its name, source, member status and next follow-up, with:

* a stage select for the hand-settable stages, saved at once, and a follow-up
  date field, saved when it loses focus (a partly typed date keeps the saved
  one);
* **Book a trial class**: pick a date and a class that hasn't started yet, which
  books through the staff booking route (`POST /api/bookings`, no waitlist).
  The dialog can't be closed while it saves. Only after the
  booking succeeds, a lead still new or contacted moves to trial booked with a
  second, revision-checked call. A failed booking leaves the stage alone; a
  booking whose stage update fails or conflicts says so and reloads;
* **Mark lost**: a reason is required;
* **Reopen** on a lost lead (it returns as contacted);
* **Convert to member**: opens the member's profile at its membership tab, where
  the existing assign flow lives.

Every write sends the lead's revision. A 409 reloads the lists and says the lead
changed; any other failure shows a message and reloads nothing.

`api.ts` validates requests and responses with the shared lead contracts and
reuses the booking client. Strings live in `locales/en/leads/screens.json`.

`node apps/web/src/features/leads/mobile-check.mjs` builds a standalone fixture of
the page with mocked API responses and checks it at 360 px and 1280 px: no
horizontal page scroll, 44 px touch targets, axe (WCAG 2 A/AA) on the board, with
lost leads shown, and in both dialogs. It needs the `e2e` dependencies
(`pnpm install --ignore-workspace` in `e2e/`) and uses `E2E_LOOPBACK` as its host.

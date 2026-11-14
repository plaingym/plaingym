<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Leads

`/admin/leads` registers through `leads.manage`: owners, admins and front desk
see it; coaches don't, and opening the address as a coach shows a notice
without calling the API. The server enforces the same permission on every
`/api/leads` route.

The board offers an **Add lead** link to the public trial form. Trial requests appear on the
board automatically; sources absent from older records display **Not recorded**.
One section per open stage (new, contacted, trial booked, trial attended), each
with its own total and its own pages of 25 ("Show more"), so a long stage never
hides another. Sections stack on phones, two across on tablets and four across
on wide screens. Lost leads stay hidden until **Show lost** adds a Lost
section. The source filter and **Follow-up due** (due today or earlier in the
gym's time zone, open leads only) apply to every section.

Each lead shows its name (a link to its lead page), source, member status and
next follow-up, with:

* **Log contact**: a dialog with the channel, an optional note and an optional
  next follow-up date (empty keeps the current one); a new lead becomes
  contacted, and the lists reload;
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

Every lead write sends its revision. A successful action refreshes its old and
new stage columns, preserving the pages already loaded, and focuses the outcome
message. A failed column refresh clears its cards so old revisions cannot be
edited. A lead-write 409 reloads the lists and says the lead changed; other
lead-write failures reload nothing. Booking conflicts explain a full class,
a closed class, a closed booking window, or a class that takes no reservations;
booking failures leave the lead stage unchanged. Existing bookings are returned
successfully by the booking API.

Contact notes (2,000 characters) and lost reasons (500) count trimmed Unicode
code points on submit, including emoji; overlong text shows a field-specific error.

## Lead page

`/admin/leads/<memberId>` (`lead.tsx`) has the same `leads.manage` gate. It
shows the lead's details (email and phone as links, member status, source,
follow-up, last contact and added times in the gym's zone, and a lost lead's
reason), a link to the member profile, the same quick actions as the board
(a won lead keeps only its follow-up date), and the contact log: a form to log
one (as the dialog, then the log reloads and the page shows the new stage) and
the contacts newest first, 20 at a time with "Show more", each with its channel,
time, who logged it and the note. A missing, erased or non-lead member shows a
"not found" notice with a link back to the list.
After a quick action, the returned lead is shown immediately and actions stay
disabled until the detail refresh completes. A failed refresh keeps them disabled
and shows a Try again button.

## Follow-ups due tile

`features/dashboard/leads.widgets.tsx` renders the dashboard's
`leads.follow-ups-due` widget for staff with `leads.manage`: the count, up to 20
due leads linking to their lead pages, "Showing N of M" when there are more, and
a link to the leads list. With nothing due the dashboard shows no tile.
Its count and list use the dashboard's shared count renderer.

`api.ts` validates requests and responses with the shared lead contracts and
reuses the booking client. Strings live in `locales/en/leads/screens.json`.

`node apps/web/src/features/leads/mobile-check.mjs` builds a standalone fixture of
the page with mocked API responses and checks it at 360 px and 1280 px: no
horizontal page scroll, 44 px touch targets, axe (WCAG 2 A/AA) on the board, with
lost leads shown, in the lost, booking and log-contact dialogs, on an open and a
lost lead page, and on the follow-ups due tile with 20 leads. It needs the `e2e` dependencies
(`pnpm install --ignore-workspace` in `e2e/`) and uses `E2E_LOOPBACK` as its host.

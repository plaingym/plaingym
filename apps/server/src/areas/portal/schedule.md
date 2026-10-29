<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal schedule, check-in and progress

Every route reloads the login's household link on each request through
`MemberHouseholdContext` and reads household data only through `forHousehold`.
Role, household and member scope never come from a request body. A member ID
outside the login's scope, in another household or in another gym, answers 404.
The payer acts for every member of the household; an adult member who isn't the
payer acts only for themself.

## Schedule

`GET /api/portal/schedule?from&to` lists the gym's classes in the range. Each
class carries the booking engine's own times: `bookingOpensAt` (from
`bookingOpensAt`) and `cancelBefore` (from `cancellationCutoffAt`, the instant
`cutoffPassed` compares against, so cancellation at exactly that instant is
allowed). The waitlist is promoted only until the same cutoff. `placesLeft`
is a count from `openPlaces`: it is zero while anyone is waiting, because a new
booking never jumps the waitlist, and `null` when the class needs no booking.
`bookings` lists only the active places of members this login may see, read from
the household's booking list (`forHousehold` has no narrower query) and narrowed to
the page, with
their place in the queue and without who created them. Staff notes and other
members' places are never included.

`GET /api/portal/schedule/members` lists the members this login may book for,
by ID and display name only: the payer first, then the rest of the household,
leaving out erased and cancelled members. An adult member gets only themself.

Booking, waitlisting and cancelling use the booking engine's portal endpoints
(`bookings.routes.ts`); this part doesn't reimplement capacity, the window or
the cutoff.

## Check-in code

`GET /api/portal/members/{memberId}/checkin-code` shows the member's current
derived code, or `code: null` when there is none (never issued, or revoked by
staff). `POST` with the member's `revision` replaces it: the old code stops
resolving at once. Both use the same code service as staff and the kiosk, over
the gym's encrypted key, and the grant is checked again after a replacement so a
login revoked meanwhile never receives the new code. Without a configured key
the routes answer 503 after authorization.

## Progress and attendance

`GET /api/portal/members/{memberId}/progress` returns the member's promotion
history, and for each program they hold a rank in, its current rank, next step and
criterion progress. All of these come from the ranks service (`memberProgress`),
which uses the same rank-system ordering (`progression.ts`) and criterion providers
as staff eligibility; attendance-based criteria count in the household's scope. The
current rank, the next step and the history order come from one ordering, so equal
promotion times can't make them disagree. `next` is `null` at the top rank and in
inactive programs; `current` is nullable in the contract for a program without a rank.
The reference `programs` and `ranks` carry only names, colors and sub-rank names
the gym stored. Promotion notes, the promoting coach and criterion configuration
are never returned.

`GET /api/portal/members/{memberId}/attendance` pages the member's visits,
newest first, through the shared attendance queries in household scope.

## Composition

`configurePortalCheckin(codeService)` and `configurePortalProgress({ ranks,
attendance })` supply the runtime services; the schedule needs no configuration.
`schedule.testing.ts` composes the real services over the test database for the
route tests, which cover payer and adult-member scope, other households, other
gyms, revoked logins and non-member principals.

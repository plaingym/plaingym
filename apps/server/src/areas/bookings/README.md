<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Bookings

Booking-rule conflicts include the translated message and a stable
`error.details.reason` list containing the rule key (for example `full`,
`sessionClosed`, `windowClosed` or `noReservation`). Existing bookings remain
idempotent successful responses.

`createBookingService` supplies staff booking, cancellation, history and the
booked-versus-checked-in roster. The portal adapter uses `MemberHouseholdContext`
and reads members/bookings through `forHousehold`. Mutations recheck the login
and member household inside the booking transaction. Portal responses omit the
user who created the booking. An adult non-payer can only book for themself;
a payer uses the household-member paths for other members, or when their login
has no member profile of its own.

For a new portal booking or waitlist entry, a pack holder (`isPackHolder`: a
member with a class-credit lot that wasn't refunded in full) needs a usable,
unexpired credit or an active membership (`active` or `trial`). The booking transaction uses the pack ledger helpers after checking
the portal's member access and before inserting anything. A refusal is a
translated conflict. Members who have never held credits and staff-created
bookings keep their existing rules. Booking does not reserve or spend a credit;
replaying an existing booking still returns that booking.

Every booking change locks its session with `FOR UPDATE`, recounts active
bookings and writes/audits in the same short transaction. A booking also locks
the member first, matching erasure's lock order. Repeating a booking or
cancellation returns the existing result without another mutation. Cancelled
bookings remain history; rebooking creates a new row.

Waitlist allocation uses the largest active allocation plus one. Cancellation
and promotion leave gaps; `queueRank` is the current place in line, including
members outside the viewer's household, without exposing their identities.
A new booking first reconciles the queue under the session lock, so it never
takes a place promotion could fill.
Inline promotions use the system audit actor. `book` returns `{ booking, promoted }`;
the staff and portal adapters enqueue each promotion's notice after commit with
`createBookingDelivery().enqueueNotice`, and expose only the caller's booking.

`reconcileSessionBookings` is the single rule called **under the session lock**
by new bookings, both schedule capacity-update paths and promotion. A capacity below the
number already booked is rejected, rolling back the capacity and revision.
Increasing capacity confirms the lowest waitlist positions first. Setting
capacity to `null` removes the reservation requirement and confirms any existing
waitlist; new bookings are then unnecessary and rejected. A cancelled or started
session never promotes. `promoteWaitlist(gymId, sessionId, options)` acquires the
lock itself and is safe for after-commit callers, including member erasure.

Promotion skips a waitlist entry the member made in the portal (`booked_by_kind`
`member`) while they hold a class pack, have no active membership and have no
usable credit, as a new portal booking would be refused; the entry keeps its place
in the queue and the next member is promoted. A staff-made entry is promoted as
before. Promotion stops at the cancellation cutoff, so every promoted place can
still be cancelled. `reconcileSessionBookings` reads the gym's current cutoff
under the session lock and applies the same comparison as cancellation:
promotion at the exact cutoff is allowed, and after it the waitlist is frozen.
This covers every path (cancellation, capacity changes, erasure and the recovery
job and new bookings). A capacity change after the cutoff is saved without confirming anyone.
Staff and portal members can book a free place after the cutoff, while existing
waitlisted members keep their frozen positions. Joining a full class's waitlist
after the cutoff is refused with reason `waitlistClosed`.
The portal shows a full class without a waitlist action after the cutoff.
Both staff booking forms use the schedule response's server-derived `cancelBefore`
instant and hide the waitlist option as an open form crosses that cutoff. A free
place remains bookable after the cutoff.

Readers share the same rules: `cancellationCutoffAt` is the instant `cutoffPassed`
compares against, and `openPlaces` counts the places a new booking can take now
(after reserving any places promotion can fill). Waiting members without usable
credits and a frozen waitlist do not hold free places. The service's `openPlaces(gymId, sessionIds)` returns
those counts for reservable sessions without exposing who holds a place; the portal
schedule shows them beside each class.

The booking window opens at midnight in the gym's timezone, the configured
number of calendar days before the class date. Zero days means the class date.
The cutoff is elapsed minutes before the start; cancellation at the exact
cutoff is allowed, after it is rejected for both staff and members. A replay of
an already successful cancellation still succeeds. All rules use the injected
clock and `GymSettingsAccessor`; calendar conversion uses the shared time module.

## Promotion notices

`createBookingDelivery` provides the `bookings.promote` and `bookings.notice`
handlers and a recovery scan every five minutes. Cancellation queues promotion
after committing. The scan also finds vacancies after a restart or erasure.
Capacity edits promote in their locked transaction. Promotion audits are durable
delivery work: a restart between promotion and enqueue is recovered by scanning
them, excluding bookings with a successful delivery audit. Notice jobs have a
stable idempotency key per booking; the durable audit prevents replay and keeps
the scan from recreating sent notices after job retention removes their keys. The same key
records durable send state (`infra/email/README.md`): once SMTP accepted the
notice, or may have, a retry never sends it again, even if the process failed
before the audit committed. Only a definite non-send is retried.
Promotion email uses the member's own email, falling back to the household's
billing address under `householdRecipients` suppression rules. It names the
promoted member, and rechecks the current booking, member-email switch, erasure
and recipient preferences immediately before SMTP.

After email, the notice job independently attempts a text when the constructor
receives `sms: { resolver, phoneDigest }`. The gym-aware resolver is the same
`SmsResolver` used by settings; `phoneDigest` is supplied by
`createSmsPhoneDigest(AUTH_SECRET)`. Without this injection the composition sends
only email. `memberNoticePhones` prefers the member's own consented phone and
otherwise uses their consented household billing phone. `MemberSms` enforces
notices consent, current phone and household membership, the independent SMS
switch and daily cap. Announcement consent alone is insufficient.
The text starts with the gym name and names the promoted member, class, date and
time in the gym's timezone. The durable key is
`booking-promotion-sms:<bookingId>`; accepted or uncertain attempts never resend.
Only a definite non-send retries. Texts are independent of email acceptance,
suppression, missing SMTP and the email switch. Both channels still require a
recent promotion, an unstarted scheduled class and a current booked participant.
Ordinary booking confirmations and member booking cancellations send no notice.
Unsent promotions expire after the jobs module's exported succeeded-retention
default, so recovery stops before a completed notice job's key can be pruned.
The notice handler logs when it skips a stale or missing promotion.
The retention test checks that this window matches the runtime queue's effective
succeeded retention, including an explicit override. A failed notice enqueue
after a staff or portal booking commits is logged; the response still returns
the committed booking, and the scan recovers its promotion notice.

`createBookingMailer` uses `createSmtpResolver` for each gym's encrypted SMTP
settings (with its existing install fallback). The runtime may inject the demo
outbox instead. The notice's own send guard (not `MemberEmail`, since the
recipient may be a household billing address) reloads the gym's member-email
switch, the booking and the recipient's delivery/opt-out settings immediately
before sending. No usable address (neither the member's own nor an unsuppressed
billing address), erasure, cancellation and a class that has started suppress the notice;
they do not undo a confirmed place. SMTP failure retries delivery without
repeating promotion. No network operation runs inside a database transaction.

Runtime composition supplies the queue and mailer to `createBookingDelivery`,
then passes the result to `configureBookingJobs`, `configureBookingRoutes` and
`configurePortalBookingRoutes`. The existing area barrels already include the
routes and jobs. Erasure's after-commit caller can pass each freed session to
`promoteWaitlist`; the recovery job queues the resulting notices.

## Staff panels and checks

`features/bookings/registrations.ts` registers a session roster and a member
profile tab. Both let staff book or cancel places; the roster includes walk-ins.
The member tab chooses classes by a gym-local date. Views use paginated booking
contracts: the roster includes `displayName` (first and last name) from a
gym-scoped query; the member tab uses the schedule projection for class names.
No additional member profile fields are exposed. A roster page needs one request;
its booking form separately reads the session detail for the cancellation cutoff.

The roster response carries `counts` for the whole session, not the page:
`booked`, `waitlisted` (one grouped query over active bookings) and `checkedIn`
(every check-in, walk-ins included). Cancelled bookings are not counted. The
roster panel shows them in its heading and publishes them to the session dialog
(`lib/session-summary.tsx`), which shows them beside the capacity; the schedule
feature does not import the bookings feature. The panel reloads its counts after
a booking or cancellation, after a capacity change in the dialog (which can
promote or move bookings), and after a check-in in the dialog's attendance panel (which tells the
dialog through the same module). While the tab is visible, it also reloads every
45 seconds, on window focus, and when the tab becomes visible again. A failed
background reload or manual Refresh keeps the last rows and counts with stale
notices beside both the roster and the dialog summary; the next
successful load clears that notice and its load error, preserving any action
error until a manual Refresh, a page change or the next booking or cancellation.
A shrinking roster returns to its last available page without clearing retained
rows during an automatic reload. Every reload gets current member names from
the roster response. Focus and visibility events within a second are coalesced.

The Postgres tests cover concurrency, queue gaps, cutoff/window boundaries,
capacity revision rollback, erasure, route permissions and household/gym
isolation, plus registered jobs, retry/recovery and captured SMTP delivery.
The optional browser check uses the actual panels with fixture service data:

```sh
pnpm --dir e2e install --frozen-lockfile
node apps/web/src/features/bookings/browser-check.mjs
```

It exercises booking/cancellation, dialog stale-count recovery and membership
price labels at 360 and 1280 px, checks overflow and 44 px panel targets, runs
axe WCAG A/AA, and writes screenshots/results under
`coverage/bookings/browser`. It defaults to installed Edge; set
`E2E_BROWSER_CHANNEL` for another installed Playwright channel, and
`E2E_LOOPBACK` to bind another IPv4 loopback address.

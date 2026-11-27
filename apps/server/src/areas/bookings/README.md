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

For a new portal booking or waitlist entry, the member's status must be
`active`, `trial` or `visitor` (the statuses the kiosk lets check in), read
under the member lock in the booking transaction; `prospect`, `frozen` and
`cancelled` members are refused with `inactiveMember`. Then a pack holder
(`isPackHolder`: a member with a class-credit lot that wasn't refunded in full)
needs a usable, unexpired credit or an active membership (`active` or `trial`).
The booking transaction makes both checks after checking the portal's member
access and before inserting anything. A refusal is a translated conflict.
Staff-created bookings have neither check. Bookings a member already holds stay
when their status changes, and they can still cancel them. Booking does not
reserve or spend a credit; replaying an existing booking still returns that
booking.

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
the staff and portal adapters pass each promotion's id to
`createBookingDelivery().enqueueNotices` after commit (a failure is logged and
the sweep recovers it), and expose only the caller's booking.

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
before the audit committed. The sent audit is written under the booking's row
lock, once per booking, and not for a booking deleted during the send. Only a
definite non-send is retried.
Promotion email uses the member's own email, falling back to the household's
billing address under `householdRecipients` suppression rules. It names the
promoted member, and rechecks the current booking, member-email switch, erasure
and recipient preferences immediately before SMTP.

After email, the notice job independently attempts a text when the constructor
receives `sms: { resolver, phoneDigest }`. The gym-aware resolver is the same
`SmsResolver` used by settings; `phoneDigest` is supplied by
`createSmsPhoneDigest(AUTH_SECRET)`. Without this injection the composition sends
only email. `memberNoticePhones` prefers the member's own consented phone and
otherwise uses their consented household billing phone. As for billing notices,
a phone counts only while its stored number still normalizes to its `phoneE164`
for the gym's country, so a member phone left stale by a country change falls
back to a current consented billing phone. `MemberSms` enforces
notices consent, current phone and household membership, the independent SMS
switch and daily cap. Announcement consent alone is insufficient. After the
provider credentials resolve, the text's last check runs first in the
transaction that takes the cap slot, through `lockBookingNotice` in
`bookings.sms.ts`. It locks and reads the gym settings, locks
the class session and loads the promotion once, then locks the member and
their household before rechecking the preferred consented phone. Staff
cancellation takes the same session lock before changing the booking. A promotion
no longer eligible
(such as a cancellation that committed first), no consented phone, or a
preferred phone other than the one the attempt started with (such as the
member's own newly consented phone) suppresses the text without taking a slot.
The last check returns the locked recipient group's consent holders and a body
built from the locked promotion and gym timezone, so a switch between member
and household consent at the same number still sends and a reschedule or
timezone edit shows the updated time. The settings read there decide everything
after it: the SMS switch, the country that validates stored phones, the
timezone of the usage day and the daily cap. A cancellation that comes later
waits until the slot commits, then cancels as usual.
A promotion text gives way to a staff erasure or deletion of the member. Those
lock the household and member before the member's class sessions, so the last
check takes the member and household locks without waiting. When either is
busy, it rolls back with no slot, releasing the session, and tries again from
the booking reread after a short pause, within the same preparation deadline.
Once the erasure or deletion commits, that reread suppresses the text. A check
still busy when the deadline is used up is suppressed too.
The text starts with the gym name and names the promoted member, class, date and
time in the gym's timezone. The durable key is
`booking-promotion-sms:<bookingId>`; accepted or uncertain attempts never resend.
The delivery row records a suppressed text as a definite non-send. After a
successful email, the registered job finishes without scheduling another text.
A later attempt under the same key (for example an explicit replay of the notice) picks its recipient
again and texts the member's current preferred phone once. Texts are independent of email acceptance,
suppression, missing SMTP and the email switch. Both channels still require a
recent promotion, an unstarted scheduled class and a current booked participant.
Ordinary booking confirmations and portal cancellations (self or household) send no
notice; a staff cancellation sends one only when staff choose it (below).
Unsent promotions expire after the jobs module's exported succeeded-retention
default, so recovery stops before a completed notice job's key can be pruned.
The notice handler logs when it skips a stale or missing promotion.
The retention test checks that this window matches the runtime queue's effective
succeeded retention, including an explicit override. A failed notice or
cancellation-promotion enqueue after a staff or portal booking or cancellation
commits is logged and swallowed by `BookingDelivery` (`enqueueNotices`,
`requestPromotion`); the response still returns the committed booking, and the
scan recovers the promotion notice or the freed place.

`createBookingMailer` uses `createSmtpResolver` for each gym's encrypted SMTP
settings (with its existing install fallback). The runtime may inject the demo
outbox instead. The notice uses a send guard that supports household billing
addresses. The guard reloads the gym's member-email switch, the booking and the
recipient's delivery/opt-out settings immediately
before sending. No usable address (neither the member's own nor an unsuppressed
billing address), erasure, cancellation and a class that has started suppress the
notice. A confirmed place remains booked. A suppression at the send guard logs
`email.suppressed` through `logEmailSuppression`. The email pass logs
`bookings.notice_skipped` for a stale or missing promotion once per job, whether
or not member emails are on; the text pass and the send guard don't log it again
(a promotion gone stale at the guard logs only its `email.suppressed`). SMTP failure retries
delivery without repeating promotion. No network operation runs inside a
database transaction.

Runtime composition supplies the queue and mailer to `createBookingDelivery`,
then passes the result to `configureBookingJobs`, `configureBookingRoutes` and
`configurePortalBookingRoutes`. The existing area barrels already include the
routes and jobs. Erasure's after-commit caller can pass each freed session to
`promoteWaitlist`; the recovery job queues the resulting notices.

## Staff cancellation notices

The staff `POST /api/bookings/{id}/cancel` takes an optional JSON body: `notify`
(boolean), `channels` (one or both of `email` and `sms`, each once; the schedule
contract's `cancellationNoticeChannelsSchema`) and `note` (up to 1,000 characters).
An empty request cancels without telling the member, regardless of its content type.
A nonempty request must use a JSON content type and pass validation. Sending `{}`
or omitting `notify` cancels without a notice. `notify: true`
without `channels` uses both. `channels` without `notify: true`, an empty or
repeated list, or an unknown channel is a 400 and changes nothing. The portal
cancellation routes take no body and never queue this notice.

`bookings.cancel-notice.ts` owns the `bookings.cancel_notice` job. The service
queues it, keyed `booking-cancel-notice:<bookingId>` with the chosen channels and
the note (kept only with email), in the transaction that cancels the booking and
writes its `booking.cancelled` audit (with `noticeChannels` in `after` when a
notice is queued) (`withJobTransaction`): a rolled-back cancellation leaves no
job, and an already-cancelled booking returns its earlier result without one. The
booking jobs register its handler, and `createBookingDelivery` binds it to the
same mailer and SMS options as the promotion notice (`enqueueCancelNotice`,
`sendCancelNotice`).

The same transaction first queues the promotion request for the freed place
(`bookings.promote`, keyed `booking-cancelled:<bookingId>`, which the route's
after-commit request then finds). A rollback drops both jobs. Cancellation
notices run on their own lane, the job queue's notices lane, which no other booking
job uses, so a slow mail server or SMS provider can't delay a waitlist promotion:
while a notice is sending or waiting to retry, the gym's promotions, including a
failed promotion's retry, are still claimed in the default lane before the
cancellation cutoff. The gym's batch work (a charge run, an import or an
announcement) runs in the batch lane, so it doesn't hold the notice's lane either;
a notice waits behind batch work only when the worker's slots shared by batch and
notice jobs are full (`infra/jobs/README.md`, Notices lane). Another member notice
of the gym (a class cancellation or restore notice) can, as the lane runs one job
per gym at a time.

After commit the handler attempts only the chosen channels, each under its own
durable key (`booking-cancel-email:<bookingId>`, `booking-cancel-sms:<bookingId>`),
apart from the promotion keys. Email goes to one recipient from
`readMemberNoticeEmails` (the member's own address, or the household billing
address); text goes to the consented phone from `memberNoticePhones` through
`MemberSms` notices consent, switch and cap checks. Both name the member whose
booking was cancelled, at the member's own address or phone too, since siblings
can have one parent's address or phone on their own records. Right before each provider
call the handler rechecks that the booking is still cancelled, its class hasn't started, it is still the
member's latest booking for that class (rebooking adds a new row; a later booking
supersedes this one whatever its status, so after a rebooking only the latest
cancellation's notice and note can go out; creation time orders the rows and the
time-ordered booking ID breaks a tie), the member isn't erased, the channel's
switch is on and the address or consented phone is still the one reserved. For a text, as for the promotion text, the
recipient is checked again after provider credentials resolve, first in the
transaction that takes the cap slot, through `lockBookingNotice` in
`bookings.sms.ts`, since `MemberSms` accepts a household phone
for any member of that household. That check locks and reads the gym settings,
locks the class session, rechecks that the booking is still cancelled, its class hasn't started and it is still
the member's latest for the class, then locks the member and their household
(giving way to a staff erasure or deletion as the promotion text does) and reruns
`memberNoticePhones`: a member who gained their own consented phone meanwhile
isn't texted on the household phone (`phone_changed`), and a booking no longer
eligible or no consented phone suppresses it (`no_consent`, which `MemberSms`'s
own log still records after that last check; a missing booking row at that check
also logs `not_current` on `sms`), without taking a
slot. Both name the class and its local date and time; only the email
carries the note. A failure on one channel doesn't stop the other; the job retries,
and an accepted or uncertain channel is never sent again. When a booking or guard
check skips a channel (`class_started` or `not_current` on `email` and `sms`,
`recipient_changed` on `email`, `no_recipient` on `email` and `sms`, or
`no_mailer` on `email` when SMTP is missing), the handler logs
`bookings.cancel_notice_skipped` with that `channel` and `reason` instead of
logging an email opt-out. On an email guard skip, the guard returns `opt_out` so
the email delivery row records `not_accepted` (without logging an email opt-out)
while the bookings log has the real reason; switch-off returns stay silent. Each
accepted channel writes one `booking.cancel_notice_sent` audit with `{ channel }`
per booking and channel in its own transaction (locking the booking row
`FOR UPDATE` before checking for an existing audit). A booking that no longer
exists (its member was deleted) gets no notice audit, even when a channel was
accepted, so the lock always covers the write. While the booking exists, a retry
that finds a channel already accepted records that single audit before any other
check and logs no skip for it; `occurredAt` on a recovered audit is when it was
recorded, not when the delivery was accepted. Suppressed, skipped, failed, and uncertain
(`unknown`) channels write none. A promotion the
cancellation frees keeps its own notice.

The email follows the same address rules as other individual booking notices:
`readMemberNoticeEmails` checks the booked member's own flags for their direct
address, and the household's flags for the billing fallback. It doesn't apply the
whole-class mailbox check that a cancelled class's notice uses
(`readAddressGroup`), so a mailbox shared with another member who opted out or
whose address is marked undeliverable still receives this member's notice.

## Staff panels and checks

`features/bookings/registrations.ts` registers a session roster and a member
profile tab. Both let staff book or cancel places; the roster includes walk-ins.
The roster's **Cancel booking** asks first, in place of the roster (inside the
session dialog this stays one dialog, whose dismissal guards a ticked box or a typed
note): separate **Email** and **Text** boxes, both unticked, and a note for the
email while **Email** is ticked. With neither ticked the request carries no notice
fields; **Keep booking** sends nothing. The roster retains the selected member
and waitlist choice in its add-booking form while staff confirm a cancellation.
A refused request shows its error beside the
kept choices and note, ready to retry. The member tab cancels straight away,
without a notice.
The member tab chooses classes by a gym-local date. Views use paginated booking
contracts: the roster includes `displayName` (first and last name) from a
gym-scoped query; the member tab uses the schedule projection for class names.
No additional member profile fields are exposed. A roster page needs one request;
its booking form separately reads the session detail for the cancellation cutoff.

The roster response carries `counts` for the whole session, not the page:
`booked`, `waitlisted` (active bookings) and `checkedIn` (every check-in, walk-ins
included). Cancelled bookings are not counted. Without a flag the roster lists
every member once, ordered by member ID. With `checkInEligible=true` (query strings
`true` or `false`; omitted means `false`) it first leaves out erased and Cancelled
members who have no check-in at the session, then orders booked members, the
waitlist by `queueRank`, and walk-ins, member ID breaking ties, before paging; the
total and `counts` then cover only those members. A member already checked in stays
listed whatever their status, so `counts.checkedIn` equals the unflagged roster's.
The roster reads the session's bookings and check-ins, then only those members, in
one statement (`bookings.roster.query.ts`), so its rows, places in line, total and
counts describe one moment even while check-ins and booking changes commit, and
its work follows the session's size rather than the gym's membership. The
statement orders, ranks and counts the whole session in the database and returns
names and full booking and attendance records for the requested page only. The coach check-in roster uses
the flag; the staff bookings roster does not. The
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

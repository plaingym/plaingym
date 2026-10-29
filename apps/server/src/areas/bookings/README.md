<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Bookings

`createBookingService` supplies staff booking, cancellation, history and the
booked-versus-checked-in roster. The portal adapter uses `MemberHouseholdContext`
and reads members/bookings through `forHousehold`. Mutations recheck the login
and member household inside the booking transaction. Portal responses omit the
user who created the booking. An adult non-payer can only book for themself;
a payer uses the household-member paths for other members, or when their login
has no member profile of its own.

Every booking change locks its session with `FOR UPDATE`, recounts active
bookings and writes/audits in the same short transaction. A booking also locks
the member first, matching erasure's lock order. Repeating a booking or
cancellation returns the existing result without another mutation. Cancelled
bookings remain history; rebooking creates a new row.

Waitlist allocation uses the largest active allocation plus one. Cancellation
and promotion leave gaps; `queueRank` is the current place in line, including
members outside the viewer's household, without exposing their identities.
A new booking never jumps a pending waitlist.

`reconcileSessionBookings` is the single rule called **under the session lock**
by both schedule capacity-update paths and promotion. A capacity below the
number already booked is rejected, rolling back the capacity and revision.
Increasing capacity confirms the lowest waitlist positions first. Setting
capacity to `null` removes the reservation requirement and confirms any existing
waitlist; new bookings are then unnecessary and rejected. A cancelled or started
session never promotes. `promoteWaitlist(gymId, sessionId, options)` acquires the
lock itself and is safe for after-commit callers, including member erasure.

The booking window opens at midnight in the gym's timezone, the configured
number of calendar days before the class date. Zero days means the class date.
The cutoff is elapsed minutes before the start; cancellation at the exact
cutoff is allowed, after it is rejected for both staff and members. A replay of
an already successful cancellation still succeeds. All rules use the injected
clock and `GymSettingsAccessor`; calendar conversion uses the shared time module.

## Promotion and mail

`createBookingDelivery` provides the `bookings.promote` and `bookings.notice`
handlers and a recovery scan every five minutes. Cancellation queues promotion
after committing. The scan also finds vacancies after a restart or erasure.
Capacity edits promote in their locked transaction. Promotion audits are durable
delivery work: a restart between promotion and enqueue is recovered by scanning
them. Notice jobs have a permanent idempotency key per booking, and a successful
delivery audit prevents a completed notice from being replayed. SMTP itself
cannot provide exactly-once delivery: a process failure after SMTP accepts mail
but before the audit commits can resend a notice on retry.

`createBookingMailer` uses `createSmtpResolver` for each gym's encrypted SMTP
settings (with its existing install fallback). The runtime may inject the demo
outbox instead. `MemberEmail` reloads the gym's member-email switch and the
member's delivery/opt-out settings immediately before sending. Missing member
email, erasure, cancellation and a class that has started suppress the notice;
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
contracts and the existing member/schedule projections for display names.

The Postgres tests cover concurrency, queue gaps, cutoff/window boundaries,
capacity revision rollback, erasure, route permissions and household/gym
isolation, plus registered jobs, retry/recovery and captured SMTP delivery.
The optional browser check uses the actual panels with fixture service data:

```sh
pnpm --dir e2e install --frozen-lockfile
node apps/web/src/features/bookings/browser-check.mjs
```

It exercises booking/cancellation at 360 and 1280 px, checks overflow and 44 px
targets, runs axe WCAG A/AA, and writes screenshots/results under
`coverage/bookings/browser`. It defaults to installed Edge; set
`E2E_BROWSER_CHANNEL` for another installed Playwright channel.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Announcements

Owners and admins use `announcements.send` for all five endpoints:

| Method and path | Result |
| --- | --- |
| `POST /api/announcements/preview` | Eligible recipient count |
| `POST /api/announcements/test` | One test to the authenticated sender's login email |
| `POST /api/announcements/send` | Confirm and queue an announcement |
| `GET /api/announcements` | Newest-first paginated history and outcome counts |
| `GET /api/announcements/{announcementId}` | One announcement and its counts |

Drafts have a subject (1–150 characters, no newlines), plain text body (1–10,000
characters), and optional `audience` with `statuses` and `programIds`. Statuses
default to active, trial and frozen. An empty program list means every program;
otherwise a member must hold a rank in one of the selected programs. Foreign or
missing program IDs return 404. Preview and confirmation return `conflict` with
`error.details.reason: ['disabled']`, `['no_smtp']`, or `['no_origin']` when member
email is off, SMTP is unconfigured, or the gym has no canonical HTTPS origin.
Test mail bypasses the member switch, carries a test marker
and an inert unsubscribe line, and accepts no caller-supplied recipient.

Confirmation also requires `confirm: true` and a UUID `sendGeneration`. Keep that
generation across double clicks and network retries; use a new one for another
announcement. It is stored as `send_generation`, unique within its gym, separately
from the app-generated UUIDv7 announcement ID. Existing announcements retain their
ID as their generation when upgraded. A replay returns the same row even if the
switch, SMTP or origin has since become unavailable;
reuse with different content, audience or sender conflicts. The announcement,
recipient rows (inserted in chunks of 100), audit, and idempotent job commit in one
transaction. The job uses the batch lane and its existing per-gym concurrency cap.

Each normalized address (trimmed and lower-cased) occurs once. The stored generated
`members.email_address` column trims ECMAScript whitespace, including tabs and
non-breaking spaces, using the same character set as the JavaScript normalizer.
Announcements and cancellation notices read the address from that column, so
PostgreSQL's `lower()` is the only case folding they group by. The
`(gym_id, email_address)` index supports address-group reads under forced RLS;
the original email and member write paths are unchanged. Any member at an
address with `email_opt_out`, `announcement_opt_outs`, or undeliverable email blocks
the whole address, even when that member is outside the selected status/program
audience. Anonymized members and missing addresses are excluded. Confirmation
fixes the recipient member IDs. Delivery reloads those members' current addresses,
statuses, ranks and preferences; it never adds newly eligible members.

The worker reads pending recipients in chunks of 25. It prepares the gym's mailer,
origin and name once per run, before reserving anyone, so a setup failure leaves
every recipient pending for the job retry. A short announcement-row lock
serializes reservations across workers. Each reservation has an identifier-only
`email_deliveries` key and a request digest of announcement ID plus normalized
destination. Comparing these durable digests prevents duplicates when addresses
converge, including after an earlier recipient changes their address. The digest
is not a readable address. A member's erasure clears the digests of their
announcement and cancellation notice rows in the same transaction
(`forgetErasedAddressDigests`, `erasure.ts`), so another member still at that
address could get a copy of an announcement that is still being sent.
Reservation and `issueUnsubscribeLink` commit together.
The worker renders before reserving, using a fresh random unsubscribe token that
only becomes usable when the reservation commits. It reads eligibility once per
recipient, after rendering, including all members at the exact normalized address
and ranks only for those loaded members. The digest lookup uses the
`(gym_id, command_digest)` index. It then sends through `MemberEmail` outside the
transaction, which rechecks the switch, current member address and global flags.
The recipient's own HTTPS unsubscribe URL appears in the HTML, plain text and
`listUnsubscribe` transport field. The shared React Email layout identifies the
gym and supplies the linked footer (inert for test copies); text is escaped and
only HTTP(S) body URLs become links.

A live reservation defers to a job retry; after the email module's ten-minute
in-flight window it counts as failed/unknown. An accepted reservation repairs the
recipient to sent after a crash. Unknown and definitely rejected attempts both
count as failed and are never resent by this announcement. Turning off the switch
skips unreserved recipients as disabled. Once every recipient is decided, including
an empty audience, the announcement becomes sent; failed/skipped counts still
describe its outcomes. Every decision and completion is audited without message
content, addresses, or tokens.

Database checks keep `sent` paired with a completion timestamp and require reasons
only for failed/skipped recipients. The expansion migration normalizes unchecked
legacy pairs before applying those checks, preserving recipients and message content.

`core/runtime.ts` calls `configureAnnouncements(createAnnouncementsService(...))`
with the job queue, `createSmtpResolver`, a gym mailer, canonical HTTPS gym origin,
and a trusted authentication lookup `senderEmail(gymId, userId)` (the account
service's `userEmail`). The lookup returns that staff user's login address, never a
member address or a request field. Demo
composition sets `demoMode: true` and passes `demoEmailFor` from the demo runtime:
neither SMTP resolution nor the production mailer is called. Missing demo outbox
wiring fails closed. Until `configureAnnouncements` runs (a test app without the
runtime), the routes answer 503.

The unsubscribe service and public signed-link pages retain the independent,
one-member announcement preference. They do not change the member's global email
opt-out or suppress transactional mail.

## Class-cancellation notices

The schedule service enqueues `announcements.cancellation` in the cancellation's
transaction with a snapshot of booked and waitlisted member IDs, the session ID
and an optional plain text note. Its job key is `schedule-cancel-notice:<sessionId>`.
This is a notice about the member's own booking: it ignores `announcement_opt_outs`
and carries no unsubscribe link. It honors the member-email go-live switch,
`members.email_opt_out`, email deliverability and erasure. Any globally opted-out
or undeliverable member at an address blocks that address, including members
outside the cancellation snapshot.

Delivery reloads the snapshot's current addresses, groups them after trimming and
lower-casing, and sends one email per address naming all of its booked and
waitlisted members. It never adds members outside the snapshot. Each message
identifies the gym and class, the date and time in the gym's timezone, the escaped
plain text note, and the portal schedule link. The group is checked again at the
send boundary and the transport is wrapped in `MemberEmail`.

A short session-row lock serializes `email_deliveries` reservations. Keys contain
the session ID and the address group's first member ID; a digest of session ID
and normalized address also prevents duplicate destinations when addresses change
or converge. No SMTP runs inside a transaction. Live reservations defer to a job
retry. Accepted, unknown and definitely rejected attempts are not resent by this
notice; a setup failure before reservation can be retried. A send outcome writes
an audit without the address or message content.

`core/runtime.ts` calls
`configureCancellationNotice(createCancellationNotice({ jobs, mailer, origin, ... }))`.
`mailer` resolves each gym's SMTP configuration, and `origin` supplies its canonical
HTTPS origin. The area's job barrel already registers the handler. Demo composition
passes `demoMode: true` and `demoEmailFor` from the demo runtime: the production
mailer is never called, and a missing demo outbox fails closed. Without that setup
(a bare service in a test), requesting notification fails with 503 and rolls back the
cancellation. Tests may inject the same service through
`createScheduleService({ cancellation })`.

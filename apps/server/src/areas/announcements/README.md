<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Announcements

Owners and admins use `announcements.send` for all six endpoints:

| Method and path | Result |
| --- | --- |
| `POST /api/announcements/preview` | Eligible recipient count |
| `POST /api/announcements/test` | One test to the authenticated sender's login email |
| `POST /api/announcements/test-sms` | One test text to the supplied `testTo` phone, counted against the daily cap |
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

Drafts may also include `sms: { body }`. The server prefixes the gym name and
appends `Reply STOP to opt out`; the complete text must fit within 480 UTF-16
code units. Preview includes `smsRecipientCount` and `smsSegments` using the
shared GSM-7/UCS-2 counter, including escape characters and surrogate pairs.
Text recipients require announcements consent and a valid normalized member
phone; notices consent and email unsubscribe preferences do not qualify or block
them. One recipient group represents each phone, with consenting member IDs
snapshotted at confirmation. Text consent, phone and audience are checked again
at delivery. The text test uses the entered number directly, bypassing member
consent and quiet hours, but consumes the gym's daily cap.

`announcements.send-sms` is a separate batch job. Email sends immediately; texts
send only from 08:00 inclusive to 21:00 exclusive in the current gym timezone.
Outside this window, including a batch crossing 21:00, a transactional enqueue
sets `runAt` to the next 08:00 and records `smsScheduledFor`. Shared time helpers
handle clock changes. A final check at the provider boundary catches slow
preparation crossing 21:00. Independent `announcement_sms_recipients` rows and
persisted SMS counts leave email outcomes unchanged. `smsCompletedAt` marks text
completion, independently of the email `status`.

Text reservations use `announcement-sms:<announcementId>:<recipientRowId>` and
a keyed phone digest under the announcement lock. Existing member-keyed
reservations still prevent replay. Member delivery uses `MemberSms` with kind
`announcements`. Suppression and failures record safe reason codes only. Erasure
and deletion remove a departing member from a shared recipient group and clear
the transport digest. A pending group keeps its phone digest for the remaining
members. Erasure clears the snapshot digest when the last member leaves, while
hard deletion removes the empty group. Accepted or uncertain attempts never send
again after a crash.
Recovery retries exhausted SMS jobs with their original scheduled key.
Gym CSV exports include the announcement's text body, counts and schedule;
per-phone recipient groups remain operational send state, like email recipients.
The service accepts `sms: { resolver, phoneDigest }`; runtime composition must
supply both to enable text delivery. Job registration is in this area's barrel.

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
Announcement keys are cleared with an UPDATE subquery over the member's
recipients. Matching shared-address digests are also cleared on other recipients
of those announcements and on cancellation notices keyed by another member.
SQL computes the same JSON/sha256 digest as the sender over the indexed delivery
key ranges, using the member's stored normalized address before it is removed;
erasure does not load cancellation history into JavaScript.
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

`createAnnouncementRecoveryJobs` (`recovery.ts`) exports the per-gym
`announcements.recover` schedule for runtime registration, every 15 minutes in the
batch lane. It scans sending announcements and cancelled sessions whose start is
still in the future in pages of 100 and asks the
queue for their exhausted send jobs. It resets only failed jobs through
`retryFailed`, keeping the original job ID, key, payload, recipient snapshot and
note. A sending announcement with no pending recipients is also eligible, so an
interrupted completion write can finish. Queued, running, completed and missing
jobs are left alone; recovery never enqueues a replacement.

Recovery waits at least 15 minutes after exhaustion, doubling that delay after
each audited reset to a 24-hour cap. Once at the cap, a persistently broken send
can recover at most once per day after exhaustion. The queue's atomic reset
prevents concurrent sweeps from resetting the same failure twice. Reset audits
contain identifiers and the delay, without content or addresses. Recipient
decisions and durable email delivery keys remain unchanged, so accepted, unknown,
failed and skipped recipients are not mailed again. The same recovery policy
applies to class-cancellation notices, retaining their original roster and note,
but notices for sessions that have started are never reset. The reset and audit
are separate commits: if the audit write fails, that reset does not increase the
next backoff delay.

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
transaction with a snapshot of booked and waitlisted member IDs, the session ID,
an optional plain text note and the chosen `channels` (`email`, `sms`, or both).
Its job key is `schedule-cancel-notice:<sessionId>`. A payload without `channels`
(queued before staff could choose) sends both. The job runs only the chosen
channels: a channel not listed is never reserved or attempted.
A notice for both channels is stored in that flat shape, with no `channels`. A
notice for one channel is stored as `{ channels, notice: { sessionId, memberIds, note } }`.
A previous release requires a top-level `sessionId`, so after a rollback it fails
that job before reserving anything, instead of dropping `channels` and sending
both. Recovery (above) retries the failed job, with its original payload, once a
release that reads it is running and the session hasn't started.
This is a notice about the member's own booking: it ignores `announcement_opt_outs`
and carries no unsubscribe link. It honors the member-email go-live switch,
`members.email_opt_out`, email deliverability and erasure. Any globally opted-out
or undeliverable member at an address blocks that address, including members
outside the cancellation snapshot.
Requesting notification for an already cancelled session returns a conflict
without changing its revision, auditing another cancellation or queuing mail.

Delivery uses a member's own email or, when absent, their household's billing
email under `householdRecipients` suppression rules. The email pass groups the
snapshot by normalized address once per job. Each reservation and the final
send guard recheck only that address's original candidates for inclusion in the
message. Each email names the booked and waitlisted candidates still at that
address, in a "Booked or waitlisted members" line. The line is left out when the
only candidate there is a member at their own email, so nobody is told their own
name; a household billing address always lists who it covers. A member who moves
between address groups is omitted. Each message
identifies the gym and class, the date and time in the gym's timezone, the escaped
plain text note, and the portal schedule link. The group is checked again at the
send boundary, including the member-email switch and household billing preferences.
Address suppression uses the same indexed address-group reader as announcements.
The send guard logs `email.suppressed` with the gym ID, the group's first member
ID at reservation, and the reason. The guard renders the content once. A reload
or render failure before transport records a definite non-send, and the job
continues with the remaining addresses.

A short session-row lock serializes `email_deliveries` reservations. Keys contain
the session ID and the address group's first member ID; a digest of session ID
and normalized address also prevents duplicate destinations when addresses change
or converge. No SMTP runs inside a transaction. Live reservations defer to a job
retry. Accepted, unknown and definitely rejected attempts are not resent by this
notice; a setup failure before reservation can be retried. A send outcome writes
an audit without the address or message content.
Replaying a stored reservation repairs its missing decision: accepted becomes
sent; unknown or a stale sending reservation becomes failed with reason unknown;
definitely rejected (including a suppressed attempt) becomes failed with reason
not_accepted. Recovery uses the member ID in each original delivery key even if
the address group's first member has since changed. It checks for existing
decisions with one member-filtered SQL lookup for the matching reservations.

After the email pass, when texts were chosen, the job independently attempts notices
texts through `createCancellationSms`. Email failure, missing SMTP or an email switch
being off does not skip the text pass. When both channels fail, the email's error is
the one the job reports. `memberNoticePhones` selects each member's consented
phone, falling back to the consented household billing phone. The text pass groups
the snapshot once per job and rechecks only that phone's original candidates at
reservation and the remaining candidates at send. One text per phone names
the candidates still covered ("Members: …"), prefixed with the gym name and
including the class's date and time in the timezone read at the start of the text
pass. When the phone is one member's own consented phone covering only them, the
text (`sms_self`) leaves the names out; a household billing phone (its group's
`consentHouseholdIds`) always lists who it covers. Announcement consent
alone never authorizes these texts. `MemberSms` rechecks notices consent, current
phones and household membership, the independent member-SMS switch and daily cap.

`sms_deliveries` keys are `schedule-cancel-sms:<sessionId>:<firstMemberId>`.
A session-scoped keyed phone digest also prevents another text to the same
destination after the first member leaves the group or groups converge. Neither
the phone nor message content is stored in those keys or digests. Live attempts
defer to a retry; accepted and uncertain attempts never resend. Only a definite
non-send can retry. A failure on one phone does not strand the remaining phones.
Erasure clears cancellation delivery digests on the erased member's keys.
Accepted or uncertain reservations can still prevent replay using member IDs.
The optional constructor `sms: { resolver, phoneDigest }` enables this pass:
`resolver` is the gym-aware `SmsResolver` and `phoneDigest` comes from
`createSmsPhoneDigest(AUTH_SECRET)`. Without that injection the service sends only
email; the application composition must provide it to enable member texts.

`core/runtime.ts` calls
`configureCancellationNotice(createCancellationNotice({ jobs, mailer, origin, ... }))`.
`mailer` resolves each gym's SMTP configuration, and `origin` supplies its canonical
HTTPS origin. The area's job barrel already registers the handler. Demo composition
passes `demoMode: true` and `demoEmailFor` from the demo runtime: the production
mailer is never called, and a missing demo outbox fails closed. Without that setup
(a bare service in a test), requesting notification fails with 503 and rolls back the
cancellation. Tests may inject the same service through
`createScheduleService({ cancellation })`.

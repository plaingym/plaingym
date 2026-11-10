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
`error.details.reason: ['disabled']` or `['no_smtp']` when member email is off or
SMTP is unconfigured. Test mail bypasses the member switch, carries a test marker
and an inert unsubscribe line, and accepts no caller-supplied recipient.

Confirmation also requires `confirm: true` and a UUID `sendGeneration`. Keep that
generation across double clicks and network retries; use a new one for another
announcement. It becomes the announcement ID. A replay returns the same row;
reuse with different content, audience or sender conflicts. The announcement,
recipient rows (inserted in chunks of 100), audit, and idempotent job commit in one
transaction. The job uses the batch lane and its existing per-gym concurrency cap.

Each normalized address (trimmed and lower-cased) occurs once. Any member at an
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
is not a readable address. Reservation and `issueUnsubscribeLink` commit together.
The worker checks eligibility again and sends through `MemberEmail` outside the
transaction, with the recipient's own HTTPS unsubscribe URL in the HTML, plain
text and `listUnsubscribe` transport field. HTML escapes text and only links HTTP
and HTTPS URLs. Each message identifies the gym.

A live reservation defers to a job retry; after the email module's ten-minute
in-flight window it counts as failed/unknown. An accepted reservation repairs the
recipient to sent after a crash. Unknown and definitely rejected attempts both
count as failed and are never resent by this announcement. Turning off the switch
skips unreserved recipients as disabled. Once every recipient is decided, including
an empty audience, the announcement becomes sent; failed/skipped counts still
describe its outcomes. Every decision and completion is audited without message
content, addresses, or tokens.

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

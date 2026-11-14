<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and households

Member list search splits on whitespace. Every word must match at least one of
first name, last name or email, ignoring case; literal `%` and `_` stay literal.
The admin members list and coach check-in roster use this same query.
The member profile puts its tabs directly below the heading, with general details
in the Profile tab and erase/delete actions in a separate final section.

Erasure clears the household billing email when it matches the erased member's
address, ignoring case and surrounding spaces, even if another member remains. A different household
address is preserved. Receipts and notices stop for a cleared address until staff
enter a new billing email.

`createMembersService` implements staff member, household, tag, medical-note and
anonymization operations. Mutations compare revisions and audit their action and
target in the same gym transaction. Audits deliberately omit personal details,
medical notes and credentials so anonymization does not leave copies in the
append-only log. Normal member projections exclude medical notes and check-in
credentials. Medical writes require both `members.manage` and `medical.read`.

Anonymization erases a member's personal data on request; ordinary off-boarding sets
the status to `cancelled` instead. It keeps member, household, invoice and attendance
identifiers. It
clears the member's contact details, birth date, emergency contacts, medical
notes, photo and check-in hash, clears the notes on its promotion history (ranks
and dates stay), clears its lead's lost reason and deletes its lead contact rows
(the lead row stays for aggregate history), clears the reasons on its class credit adjustments (the credit ledger rows stay), clears the commitment override reason on its memberships, deletes the member's signed waivers and their signature images,
removes tag and member-login links, revokes
member-specific signed links, cancels the member's memberships (in the same
transaction, so an erased member is never billed again; any plan switch scheduled
on them is dropped), and clears the household
PIN. When the household
has no remaining identifiable members, its contact details and remaining portal
and signed-link access are also removed. Other household members remain intact.
Erasure cancels booked and waitlisted places in sessions that haven't started,
under each session's row lock, clears their waitlist positions without
renumbering others, and unlinks staff profiles from the erased member. Bookings
for sessions that have started stay as history. For a household's last member it
also revokes active cards, clears the local Stripe customer ID and holds open and
past-due invoices for review. `eraseMember` takes the job queue and the gym's
timezone as a required argument and inserts every cleanup job in the erasure
transaction, so the erasure and its jobs commit or roll back together:
`billing.payments.detach` for each card it revoked (key `detach:<card ID>`,
12 attempts, a one-minute delay), `members.erasure.release_files` for the photo and signature images
it released (key `release:<member ID>`, 12 attempts, a one-minute delay), and,
when it cleared a customer ID, `members.erasure.redact_customer` carrying that ID
(key `redact:<customer ID>`, 12 attempts, a one-minute delay). It returns `files`,
`revokedCards` and `erasedCustomerId` (the cleared Stripe customer ID) for an
immediate attempt after commit. The runtime passes the billing detach callback,
the customer redaction callback (`Payments.redactCustomer`), file storage and the
job queue (required) through `configureMembers`; without a queue the erasure route
refuses with `unavailable` before changing anything. After commit the route
detaches each card, redacts the customer and marks the files deleted, each attempt
logged on failure (identifiers and safe error classifications, never message text)
and left to its job; then it promotes the
waitlist of each session the erasure freed a place in, logging a session whose
promotion fails (`members.erasure.promotion_failed`) and going on with the rest.
The existing `bookings.recover` sweep retries failed waitlist promotions every
five minutes for upcoming scheduled sessions, subject to the cancellation cutoff.
The request succeeds once the erasure commits. The release job checks that every
key carries the job's gym prefix and retries a storage failure; marking a file
deleted again is harmless. The
`household.anonymized` audit event records the cleared customer ID. The Stripe
Customer is kept for the books: its name
becomes `Erased member` and its email, phone, address, shipping details, description, individual and business names and invoice
custom fields are cleared and its tax IDs deleted. The detach jobs carry `redactBillingDetails: true`, so each card's billing
name, email, phone and address are cleared before the card is detached (Stripe updates only an attached card). A failed attempt
is logged with identifiers only and the erasure still succeeds, since its committed job retries it.

Customers erased before the redaction covered every field are handled by `members.erasure.redact_earlier`, a daily job
(`erasure-redaction.ts`): per gym it reads the `household.anonymized` audits' `before.stripeCustomerId` and queues one
`members.erasure.redact_customer` job per erasure under the stable key `redact-earlier:<erasure audit ID>`, with a
`members.erasure.redaction_queued` audit naming the erasure, so a rerun queues nothing new even after the queue prunes
finished jobs, and a customer erased, reused for another household and erased again is queued again. An erasure whose
customer a redaction succeeded for afterwards (`members.erasure.customer_redacted`, written by `guardRedaction`) needs
none, so the check queues an erasure whose own job ran out of attempts or never redacted. It reads only the gym's own
audits (row-level security), selects and limits in SQL (`erasure-redaction.query.ts`, at most 200 erasures per run; the
next run continues), and needs no start-up wiring. It skips a customer that a household of the gym links today (the gym
reused it). `guardRedaction(redact, { clock, scope })` wraps the provider redaction: it checks again when the
redaction runs, skipping and logging (`members.erasure.redaction_skipped_linked`) a customer a household links by
then, and audits a redaction that succeeds. Redaction is idempotent, so a repeat is harmless.
Unused households can be deleted; referenced households return a conflict.

Deleting a member (`deleteMember`, `DELETE /api/members/{memberId}`, `members.delete`: owners and admins) is for a
member added by mistake, such as a duplicate, a typo or a test. It is allowed until the member has billing records and
refused after that with a conflict whose `details.reason` is `billing_records` (`memberDeleteBlockedReason`); Cancel
(the `cancelled` status) or erasure applies then. The billing records are: a pack purchase or any class credit ledger
entry for the member; a membership that has been invoiced (an invoice line references it) or has a discount applied;
and, when the member is the household's last, any invoice of the household (so any payment, payment attempt or refund),
any saved card on it (revoked ones too) or a Stripe customer ID. A household's card, customer and invoices don't block
deleting a member while another member stays in the household, since they stay with it. Everything else goes with the
member in one transaction: memberships that were never invoiced, attendance and bookings, the check-in code, rank
history and promotion notes, signed waivers, tag links, the lead and its contacts, announcement recipients and opt-outs
(the delivery records lose their address digests, as on erasure), member logins and member links; a staff profile
linked to the member is unlinked. With the household's last member the household goes too, with its portal logins and
signed links. The member row is locked first (`FOR UPDATE`), then the household and the member's memberships, before
the checks, so a charge, sale or card that starts at the same moment either commits first and the delete is refused,
or waits and then fails its own reference to the deleted rows; a delete that loses such a race answers with a conflict.
Upcoming places are freed under each session's row lock and the route promotes their waitlists after commit. The
release of the photo and signature images commits with the delete as a `members.erasure.release_files` job (key
`release-deleted:<member ID>`), so the route needs the job queue like erasure does, and the route marks the files
deleted after commit as a head start. The `member.deleted` and `household.deleted` audit events carry IDs only.

`hashHouseholdPin` and `verifyHouseholdPin` take the per-gym secret, gym ID,
household ID and the PIN. They preserve leading zeros, use a domain-separated
HMAC, and compare hashes in constant time. The secret comes from the injected
`pinSecret(gymId)`; the runtime passes `createGymKeyResolver`
(`areas/settings/gym-keys.ts`), which decrypts the gym's random 32-byte key from
`gyms.qr_key_encrypted`. That key is restored with the gym, so PINs survive a restore,
and the separate HMAC domain keeps PIN hashes unrelated to check-in codes. The resolver
runs before the mutation transaction opens. A missing or short key fails closed.

Photos are resized to at most 512 pixels on the client and re-encoded as JPEG
pixels, dropping source metadata. The server bounds the request, accepts only
JPEG/PNG/WebP signatures, and stores at most 512 KiB through an injected
`(gymId) => Promise<Uploads>`. Keys are immutable and scoped to both gym and
member. Reads require member-read staff access and use private, uncached binary
responses. Uploads happen outside transactions; attaching a photo compares the
member revision. Replaced, removed and anonymized photos are marked for deferred
deletion. Storage failures after a database commit are repaired by the cleanup
job; already completed database changes remain committed.
If attachment fails, cleanup errors are logged and the original save error reaches
the caller, including a revision conflict that asks staff to reload.

`createMemberPhotoJobs` reconciles uploads left by failed or interrupted requests.
Before retiring an unreferenced key it locks the member and advances its revision,
invalidating an unfinished attachment's compare-and-set. The one-hour age filter
avoids interrupting normal uploads; correctness comes from this revision change.
Actual deletion remains the storage subsystem's backup-aware sweep.

## Composition

The runtime calls `configureMembers({ pinSecret, uploadsFor, clock, detachCard, redactCustomer, jobs })` and registers
`createMemberPhotoJobs(uploadsFor)` with the worker, using its gym-scoped uploads
resolver. Until `configureMembers` runs (or when a test passes its own service without
storage), photo operations and setting a nonempty PIN fail closed. The web feature
registration enables the Members nav entry; the profile renders every enabled,
permitted `memberTabs` registration.

Every JSON endpoint uses the shared `membersContracts`, including member, household and tag
deletion, a member's assigned tags, and photo upload. The photo read
(`GET /api/members/{memberId}/photo`) returns the image bytes, so it is declared in
`members.routes.ts` rather than as a JSON contract. The household login contracts
(`listHouseholdUsers`, `createHouseholdUser`, `revokeHouseholdUser`) are not
implemented here.

Stored household addresses and member emergency contacts strip unknown keys on
read, so a rollback can read extensions a newer minor stored. Create and update
requests still reject those keys. An update that leaves the address or contacts
out keeps the stored JSON intact; one that sends them replaces that field in full,
and the portal's household and member forms send them with every save.

## Verification

`members.test.ts` uses a real PostgreSQL database and exercises every implemented
route for all staff roles, foreign-gym resource IDs, and non-staff principals
(household payers/adults, signed links, kiosks and anonymous requests). It also
covers revision races, tag filtering, PINs, anonymization with retained accounting
and attendance rows, and photo storage/cleanup.

`members.delete.test.ts` covers member deletion: what goes with the member, the household removed with its last
member, a refusal for each kind of billing record, manager-only access, stale revisions, another gym's member (404),
and a concurrent charge that either commits first (the delete is refused) or waits and fails.

`erasure-transaction.test.ts` covers erasure/job commit and rollback, including
failure after the writes and the no-customer case, with the fake and PostgreSQL queues.

The gate is `pnpm check-types`, `pnpm lint`, `pnpm test` and `pnpm compliance`.

An emailed portal invitation replay with an uncertain delivery returns `data.outcome: "unknown"`, without issuing another invitation or sending email. The access form keeps the pending generation across reloads and offers a deliberate Send again action when the earlier email may have arrived.

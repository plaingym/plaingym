<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and households

SMS choices are independent, initially off, and attached to the normalized phone
using the gym's country. `sms` on member and household reads reports validity,
normalized phone, and each consent's timestamp and source. The billing phone has
notices consent only. `PUT /api/members/{memberId}/sms-consent` requires
`members.manage`: staff may record verbal notices consent or withdraw either
choice, but may never grant announcements consent. The household equivalent at
`/api/households/{householdId}/sms-consent` requires `households.manage`.
Both writes require the current revision. An unparseable phone cannot be opted in.
Changing a member's phone clears both choices in that transaction; changing the
billing phone clears its notices choice. Each change audits the kind, previous
and new consent, and source without recording a phone.

When the provider refuses a text because the number replied STOP, `MemberSms`
clears consent on every member and household with that number and audits
`member.sms_opted_out` / `household.sms_opted_out`. It also records the number
in the gym's `sms_opted_out_numbers` list with the opt-out's time when a current
record holds it, and removes the row when none does. `GET /api/members/{memberId}`
and `GET /api/households/{householdId}` then report `sms.optedOutAt`, the time of
that opt-out, read by `readSmsOptedOut` (`sms-opt-out.ts`) inside the request's
gym transaction: it is the newest opt-out, consent-change or number-change audit
for the record when that audit is an opt-out. Without one, and only when the
record stores no SMS consent, it is the list's date
for the record's stored number (the staff reads use the number as read for a
record with none stored; the portal reads leave such a record out), so a member or household that takes an opted-out
number later (a new record or a phone edit) while another current record still holds it shows
the STOP line too. It is null once consent is recorded again or the record's number
changes to one not on the list. The portal's household, member and payer's member
list reads report the same date through the household query `smsOptedOut`, inside
the request's household transaction and limited to the login's grant. Recording
consent for a number (staff or portal consent, or a `/join` SMS choice) removes it
from the list in the same transaction. The number is also dropped from the list
once no current member and no household holds it: after a phone change, a hard
delete (member or household deletion, or abandoned join and drop-in cleanup), an
erasure, or a refusal that found no holder. Staff list
reads, the people export and imports omit the field. The staff and portal consent
panels show the date in the gym's timezone; the staff panels also ask staff to
confirm the person replied START before recording verbal consent again. When a member's
own number is also their household's billing phone, the staff and portal panels
each say so with the other record's notices consent; consent stays with each
record.

`sms-recipients.ts` owns notice recipient selection. Call `householdNoticePhones`
or `memberNoticePhones` inside a gym transaction. Results group by `phoneE164`;
`memberIds` and `householdIds` identify whom the notice covers. Pass the separate
`consentMemberIds` and `consentHouseholdIds` as the corresponding IDs to `MemberSms`
so its final consent check uses the actual consent holders. Billing notices use
the consented billing phone first, otherwise consented members at the trimmed,
case-insensitive billing email. For billing notices a phone counts only while its
stored number still normalizes to its E.164 value for the gym's country (the same
test the household read uses), so a billing phone left stale by a country change
falls back to the consenting members. Class notices prefer each member's consented
phone, otherwise their consented billing phone, under the same current-phone test,
so a member phone left stale by a country change falls back to a current consented
billing phone. Only notices consent qualifies;
anonymized members are excluded. A shared parent phone yields one entry naming
all children covered. Delivery must still use `MemberSms` to recheck the current
phone and consent, switch and cap immediately before sending.

Member list search splits on whitespace. Every word must match at least one of
first name, last name or email, ignoring case; literal `%` and `_` stay literal.
The admin members list and the member pickers use this same query. With
`checkInEligible=true` (query strings `true` or `false`; omitted means `false`) it
leaves out erased and Cancelled members before paging, so the total counts only
who can be checked in; frozen, trial, visitor and other statuses stay. The coach
check-in roster's **Check in someone else** picker and the staff booking picker
send it; the Members page does not, and still lists every status.
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

SMS consent belongs to `phone_e164`. Staff, portal and people-import phone edits
use `smsPhoneChange` in `member-write.ts`. Reformatting the same normalized number
keeps consent. An edit to a different or invalid number clears consent and writes
the consent audits in the same transaction, followed by one
`member.sms_number_changed` / `household.sms_number_changed` audit holding only
the change source (`auditSmsCleared`). Join normalizes the new phone and records
only explicit choices. Consent writes check the revision. Repeating a choice
leaves the revision and audit history unchanged when the normalized number still
matches. A withdrawal refreshes a stale normalized number and clears all consent
stored against it, even if the requested choice is already off. A withdrawal
with no stored consent leaves the record unchanged. When a household grants
notices on a different normalized number with existing consent, it writes three
audit entries with the same time: the old consent clearing, the number change,
then the fresh grant from empty consent. All three commit with the new number and consent in a single
revision. Staff, portal and
join read the gym's country only when at least one phone needs it for national
parsing.

Staff can set a member's status, and that edit stands until their next membership
change. Assignment, any staff edit of a membership (such as its discount, due date
or plan), activation, freeze, resume and cancellation (including the daily
trial-end and resume-date job) then derive it: any active membership wins,
then any trial, then any frozen membership, then cancelled if all are cancelled
and at least one ever left pending (read from membership audit history).
Pending-only live memberships, or no memberships at all, leave the staff-set
status unchanged. Cancelling memberships that never left pending also preserves
it, including an abandoned join's prospects. This preserves prospect, visitor
and pack-only members. Imported memberships use the same rule, so an active
membership overrides an omitted or cancelled status in the people file. A
member with all memberships cancelled after a trial or activation is cancelled
even with pack credits left and must go to the front desk to check in. See the
[membership lifecycle](../billing/memberships.README.md#member-status) for audit
and transaction details.

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
keeps other members and has a Stripe Customer, every erased member with an email
queues `members.erasure.clear_billing_email` in that transaction, even if staff already
changed the local billing email (key `clear-billing-email:<erasure audit ID>`, 12 attempts). The household audit carries
`after.billingEmailCleared: true` whenever erasure clears its email, including the
last member's erasure.
The job carries the household, customer and erasure audit IDs, every unrevoked card's
processor ID, and a versioned HMAC of the trimmed, lowercased erased address rather
than its plaintext. `billingEmailSecret` receives `AUTH_SECRET` through `configureMembers`;
the payments helper derives a separate key with HKDF. The secret is never queued.
The digest remains personal data and lives only in the retry
queue, under its normal retention; it is never added to the audit or logs.
Before calling Stripe the job checks that exactly this household still links the
customer. Entering a new local billing email does not prevent clearing the old
copy at Stripe. The payments
adapter checks gym and household metadata and card ownership before any write,
then clears only matching customer and card emails. Names, other contact fields,
payment history and the card attachment stay intact. A retry rereads the fields
and preserves any replacement address. As with other provider operations, the
link check and external call cannot be one transaction; an external edit during
the call cannot be made atomic with erasure. `configureMembers` accepts the
gym-scoped `clearBillingEmail(gymId, customerId, options)` callback backed by
`Payments.clearCustomerEmail`; an absent callback or HMAC secret fails the job so it retries.
Already queued jobs with an unkeyed digest and one card ID still drain. The callback
returns whether any address matched, which of the job's pre-authorized debit
accounts hold the placeholder email `erased-member@example.com` (Stripe won't leave
one without an email), and which methods it couldn't write (the provider still writes
the others). A debit account holding the placeholder has no notice address left for
the household's debits, so the job retires each one in one transaction: it locks the
household, revokes the household's unrevoked row (no longer the default), writes
`billing.card.revoked` with `reason: 'notice_email_erased'` (and the erasure ID, when
the payload has one), and queues a plain
`billing.payments.detach` (no `redactBillingDetails`: the name may be a surviving
payer's) under `detach:<row ID>`. A card or other method holding the same address is
never retired. No new charge attempt selects a retired account; a charge the billing
runner already created and released from its final eligibility check before the
revocation committed can still confirm once. Retiring
its default leaves it with no active default, and its charges skip as `no_saved_card`
while that is true. A member can set up a new method, staff can select an active
method on file, or a finishing card import can promote one even if it adds no new
methods. Retiring a non-default account keeps the household's default. A
retry finds the rows revoked and changes nothing. The outcome audit below commits in
the same transaction as the retirements. When a method couldn't be written, the job
still commits the retirements, writes no outcome audit and fails with `Billing email
erasure incomplete`, so it retries. The job needs the erasure job queue
(`jobs`) and fails without it. A matching provider clear writes
`members.erasure.billing_email_cleared` with customer and erasure IDs only, as does a
run that finds one of the job's debit accounts already holding the placeholder (the
recovery of a run that rolled back after its provider writes), and so does a run that
finds nothing left to clear after this erasure already retired one of the household's
debit accounts (its revocation names the erasure, so a clear that succeeded before an
incomplete run is still recorded once after the account's detach has run); a no-match
run writes `members.erasure.billing_email_no_match` and leaves its marker unresolved.
Each outcome audit is written once per erasure ID: a run whose erasure already has its
cleared or skipped audit writes nothing and makes no provider call, and a repeated
no-match writes no second one. Overlapping attempts of one erasure (a reclaimed job
lease, say) take a transaction-scoped advisory lock on the erasure ID before
rereading its outcomes, on both the skip and the provider-result path, so the skip is
written only while the erasure has no outcome, even when the household row is gone. A
legacy payload without an erasure ID writes its outcome on each run.
The job itself completed, so the sweep never runs it again; the marker resolves as
`members.erasure.billing_email_job_missing` once retention removes the job.
A failure writes no completion audit. A skipped reassigned customer writes
`members.erasure.billing_email_skipped_linked`, resolving its marker. The erasure also writes the ID-only
`members.erasure.billing_email_queued` marker. The daily `members.erasure.redact_earlier`
sweep uses these markers and the queue's `JobRecovery` API to reset exhausted email
clear jobs, retaining their payload and key. Completed clears are excluded. Resets wait
1, 2, 4 and 8 days after each final failure, with a maximum of four resets recorded as
`members.erasure.billing_email_reset`. An exhausted job at that cap writes
`members.erasure.billing_email_abandoned`, logs an error with identifiers only, and leaves the sweep. Markers whose jobs
retention removed resolve with `members.erasure.billing_email_job_missing`, without
claiming that any email was cleared. The sweep pages outstanding markers 200 at a time
and resets at most 200 jobs per gym per run; it uses the queue's `failedJobs`,
`retryFailed` and `existingJobs` recovery methods. No digest or secret enters these audits.
When the household
has no remaining identifiable members, its contact details and remaining portal
and signed-link access are also removed. Other household members remain intact.
Erasure cancels booked and waitlisted places in sessions that haven't started,
under each session's row lock, clears their waitlist positions without
renumbering others, and unlinks staff profiles from the erased member, advancing their revisions so an open form cannot restore the link. Bookings
for sessions that have started stay as history. For a household's last member it
also revokes active cards, clears the local Stripe customer ID and holds open and
past-due invoices for review. It records `billing.invoice.held` with reason
`household_anonymized` for each, including invoices already held, so unpaid join
cleanup keeps the join regardless of whether the runner held its invoice first.
`eraseMember` takes the job queue and the gym's
timezone as a required argument and inserts every cleanup job in the erasure
transaction, so the erasure and its jobs commit or roll back together:
`billing.payments.detach` for each card it revoked (key `detach:<card ID>`,
12 attempts, a one-minute delay; its payload carries the cleared customer ID as
`customerId` when the household had one), `members.erasure.release_files` for the photo and signature images
it released (key `release:<member ID>`, 12 attempts, a one-minute delay), and,
when it cleared a customer ID, `members.erasure.redact_customer` carrying that ID
(key `redact:<household erasure audit ID>`, 12 attempts, a one-minute delay). It returns `files`,
`revokedCards` and `erasedCustomerId` (the cleared Stripe customer ID) for an
immediate attempt after commit. The runtime passes the billing detach callback,
the customer redaction callback (`Payments.redactCustomer`), the billing email callback (`Payments.clearCustomerEmail`), file storage and the
job queue (required) through `configureMembers`; without a queue the erasure route
refuses with `unavailable` before changing anything. After commit the route
detaches each card, redacts the customer and marks the files deleted, each attempt
logged on failure (identifiers and safe error classifications, never message text)
and left to its job. An immediate detach that Stripe refuses because the customer has no
gym tag (recognised by its `PaymentObjectUntagged` class, when a people CSV linked it) is
instead logged at info as `members.erasure.detach_deferred` (identifiers only) and left to
its job, which adopts the customer or fails with the job's error. A card on a deleted
customer is refused as not this gym's rather than untagged and, like any other immediate
detach failure, is logged as `members.erasure.detach_failed` at error with its safe
classification, and is also left to its job.
A card whose immediate detach succeeds gets its one
`billing.card.detached` audit (system actor) at once, so the card list shows it removed
from Stripe before the job runs; a failure to write that audit is logged as
`members.erasure.detach_record_failed` and the card stays pending until its job
records it. Then it promotes the
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
custom fields are cleared and its tax IDs deleted. Customer redaction also lists and clears
the billing name, email, phone and address of every attached card, including cards
added in the provider dashboard and previously revoked cards still awaiting detach.
It paginates and leaves the cards attached. The detach jobs carry `redactBillingDetails: true`, so each card's billing
name, email, phone and address are cleared before the card is detached (Stripe updates only an attached card). A method Stripe
won't leave without a billing name or email (a pre-authorized debit account) gets the name `Erased member` and the email
`erased-member@example.com` instead, in both the customer redaction and the detach. A failed attempt
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
then, and audits a redaction that succeeds. It also checks after the provider call and logs an error,
`members.erasure.redaction_relinked`, if a household linked the customer during that call; the external call and a local link cannot be atomic.
Redaction is idempotent, so a repeat is harmless.
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
linked to the member is unlinked and its revision advances. With the household's last member the household goes too, with its portal logins and
signed links. The household is locked first, then the member (`FOR UPDATE`) and the member's memberships, before
the checks, so a charge, sale or card that starts at the same moment either commits first and the delete is refused,
or waits and then fails its own reference to the deleted rows. Bookings, check-ins, tags, promotions, pack sales
and staff profile links report a conflicting reference as 409 and log the constraint name. In bookings, tags, promotions,
pack sales and staff profile links a member
visible before waiting for its lock but deleted meanwhile also produces 409; a check-in that waited answers 404, as for
a member that is gone. A missing or foreign-gym member still produces 404. A delete that loses such a race answers with a conflict and logs
`members.delete.foreign_key` for a failed foreign key. The delete test checks the database's foreign-key catalog by name,
so adding a reference to members, households or memberships requires an explicit cleanup or refusal decision.
Upcoming places are freed under each session's row lock and the route promotes their waitlists after commit. A
delete removes bookings without cancellation audits; erasure cancels and audits the bookings it retains.
Last-member erasure revokes household signed links before holding invoices, matching Checkout's link-before-invoice order.
The release of the photo and signature images commits with the delete as a `members.erasure.release_files` job (key
`release-deleted:<member ID>`), so the route needs the job queue like erasure does, and the route marks the files
deleted after commit as a head start. The `member.deleted` and `household.deleted` audit events carry IDs only.

After either erasure or deletion commits, the route revokes the member's pending portal invitations through the auth
store. With the last member it revokes every invitation and onboarding claim hold for the household. A cleanup failure
is logged as `members.cleanup.invitations_failed` and those rows expire normally. Until then an invitation for a deleted
or erased member, or for a deleted household, is refused when accepted. A payer
target also requires at least one member without `anonymizedAt`, checked with an
indexed existence query while holding the household lock. A payer invitation for
a household whose last member was erased therefore fails even if revocation failed.
Tests can inject the store through the `invitations` option; production uses the auth store directly without extra runtime wiring.
Delivery cleanup clears the member's own announcement and cancellation digests, shared-address announcement digests
for announcements they were a recipient of, and shared-address cancellation digests. SQL computes the sender's exact
JSON/sha256 digest once per known announcement and updates through the command-digest
index; cancellation notices retain their indexed delivery key range update. No
notice history is loaded into JavaScript.

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

The runtime calls `configureMembers({ pinSecret, uploadsFor, clock, detachCard, redactCustomer, clearBillingEmail, billingEmailSecret, jobs })` and registers
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

When a passwordless online join or sign-in link resend encounters a staff address,
it records `household_user.invite_refused` on the household with `after: { reason: "staff_identity" }`.
The refusal audit has no address or account identity. Updating a household's email
to a different normalized address still records `household.email_changed` without any address,
though the hint no longer reads it. The gym-scoped `inviteRefused` read feeds the staff Portal
access tab while the household has a non-blank email that is a staff login in this gym, no payer
login, and its latest refusal or successful invitation, ordered by timestamp then ID, is a refusal.

The staff invitation endpoint reports the reason under `error.details.reason` for
`already_linked_household`, `member_has_login`, `staff_account` and
`adult_birth_date_required`. The Portal access dialog explains each reason.

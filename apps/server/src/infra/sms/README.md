<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# SMS

This module supplies SMS delivery infrastructure. Billing transition effects and
card-expiry jobs accept optional text services from `areas/billing/transitions/notifications.sms.ts`
and `areas/billing/alerts/sms.ts`; both use `MemberSms` and durable delivery keys.
`Sms.sendSms({ to, body })` returns `sent` with a provider message ID or `suppressed`
with a safe reason. `verifyAccount()` sends nothing. `FakeSms` and `TwilioSms`
share the response contract suite. All adapters reject calls inside a transaction.

`TwilioSms` uses form-encoded Messages REST requests over `fetch`, with an Account
SID and Auth Token or API key and secret, and either a From number or Messaging
Service SID. Verification uses `GET Messages.json?PageSize=1` and discards the body:
standard API keys cannot read Accounts. See the [API key scopes](https://www.twilio.com/docs/iam/api-keys)
and [Messages API](https://www.twilio.com/docs/messaging/api/message-resource).
There are no automatic retries or redirects. Each request, including reading its
reply, has a 30-second hard deadline. DNS, refused connection, certificate failures
and all HTTP 4xx (including 429) prove `not_accepted`. HTTP 5xx, timeouts, resets
and malformed success replies are `unknown`. HTTP 4xx code 21610 adds the safe
`recipient_opted_out` reason. Every `SmsDeliveryError` from a request also carries
`provider: { httpStatus, code }`: the HTTP status (`null` when no response arrived,
such as a connect failure or the deadline before headers) and Twilio's JSON error
`code` when it is an integer from 1 to 999999 (else `null`). A refused base URL or
account SID, an invalid message and a malformed success reply carry no `provider`. Raw replies, Twilio's
`message` and `more_info`, request content and error causes are never exposed by
the adapter.

`createSmsResolver({ key, tenancy, scope, demo, clock, fetch })` in
`areas/settings/sms.ts` reads only the requested gym's encrypted config and returns
`{ gymId, name, sms }`, or null. `status` reports unreadable secrets, through the
same safe reporting path as SMTP. There is no install-wide fallback. Stored
config is read by the same `readSmsConfig` helper used by the settings page. Reads
ignore newer top-level and nested auth/sender keys so rollback preserves delivery.
New writes still validate strictly. A custom
HTTPS base is permitted only in single mode; multi mode permits only Twilio's
default API base. Demo mode reads no credentials and returns `OutboxSms`. Capture
and its `demo.sms_captured` audit commit together; only the outbox holds content.

Member texts use `MemberSms({ gymId, memberIds, householdIds, kind, resolver,
settings, scope, clock, logSuppression })`, inside a delivery attempt. It prefixes
the body with the resolved gym name and refuses (`not_accepted`, no slot taken) a
prefixed body over 1,600 characters, then sends after these checks commit:

* SMS enabled (default false), a configured provider bound to the same gym.
* Every member belongs to the gym and is not anonymized. The appropriate notices
  or announcements consent must exist; the stored E.164 number and the current
  phone normalized with the gym country must both equal the recipient.
* Each supplied household has notices consent for its billing phone, with the
  same number check. Its consent covers supplied members of that household even
  if they have no phone. Household consent never authorizes announcements.
* A slot under a row lock on `sms_daily_usage` for the gym's local calendar day.
  The cap is owner-editable from 1 to 100,000 and defaults to 1,000. `sent` counts reserved provider attempts;
  provider failures and unknown outcomes retain their slots conservatively. `refused`
  counts attempts suppressed by the cap. Retries of accepted delivery keys do
  not enter this wrapper or consume another slot. `remainingSmsSlots` reads the same
  row without locking it or taking a slot (the announcement preview's warning).

An optional `recheck(tx)` lets a sender repeat its own recipient check once the
credentials resolve. It runs first in the cap transaction, within the
preparation deadline and before the consent reads and cap slot, and may lock
the rows its decision reads (no nested transaction or network call). It returns
a suppression reason, or the gym's SMS switch, daily cap, timezone and phone
country read in that transaction, plus optional consent holders (`memberIds`,
`householdIds`) and a message `body` chosen under its locks. The returned
settings replace the earlier snapshot for every later step: the switch check,
phone normalization, the usage day and the slot (and so any late usage
correction). Returned consent holders replace the sender's own for the final
consent checks, and a returned `body` replaces the message text (prefixed with
the gym name and re-validated against the 1,600-character limit before taking a
slot). A failure or lock timeout is a definite non-send. A recheck that finds a
row busy throws `SmsRecheckBusy`: the transaction rolls back with no slot, and
the whole check runs again in a fresh transaction after a short pause while the
preparation deadline leaves time for another try. One still busy after that is
a `no_consent` suppression. The waitlist promotion, staff booking cancellation
and class cancellation texts use it.

Suppression reasons are `disabled`, `no_provider`, `no_consent`, `phone_changed`
and `cap_reached`; logs hold event, gym ID, member IDs and reason only. A 21610
clears both member consents and household notices consent at that E.164 number
in this gym, in one transaction, incrementing revisions and auditing each record
with source `provider`. It locks the households holding the number and the
households of the members holding it, ordered by ID, then the members holding the
number, ordered by ID, and reads its time only after every lock, so a consent
write it waited on is ordered before its audits and it shares the household-first
lock order with erasure. When at least one record still holds the number, it
upserts the number's `sms_opted_out_numbers` row with that time; otherwise it
removes any existing row for that number once no current record holds it. It
remains a definite non-send.

Provider resolution, settings reads, consent checks and the daily-usage lock share
a 15-second preparation deadline. A timeout proves `not_accepted` and permits a
retry. Transaction-local PostgreSQL lock and statement timeouts use 250 ms less
than the remaining preparation time, with a 1 ms minimum. A database timeout
during preparation also reports `SMS recipient checks timed out`. If a slot or cap
refusal commits after the deadline, the sender waits for a correction to reverse
that increment on its original local day before reporting the timeout. A lock or
statement timeout rolls back the correction and allows another attempt within
the same wait. The first attempt sets three-second lock and statement timeouts,
even when the commit arrives near or after the end of the wait; a retry's are
shortened to fit the remaining wait. If the commit arrives after the wait has
ended, the sender makes one correction attempt. Any other error ends the
correction immediately.
That wait lasts at most 30 seconds, the provider deadline a timed-out attempt
doesn't use, so either path stays inside the one-minute in-flight window.
Correction failures are logged. The provider has its own 30-second deadline.
Database outcome writes still use their guarded retries below.

`createSmsDeliveries({ scope, clock })` uses the shared `infra/delivery-state.ts`
factory with the SMS table, key validator, in-flight window and safe error policy.
It mirrors email's `send`, `state`, `replay`,
`reserve`, `remember`, `attempt` and `release`. Reserve and remember commit with
any issued credential; attempt runs afterwards. An accepted or unknown key never
sends again. In-flight attempts conflict; after twice the adapter deadline (one
minute), an unresolved attempt reads as unknown. Only a definite non-send permits
a new attempt. Outcome writes are retried without resending only after a
connection error or a serialization or deadlock failure, up to three attempts
with 50 ms and 200 ms waits, guarded by attempt number and state; any other
error fails at once. Builder failures release their reservation. A transport's `SmsDeliveryError`
reaches the caller with its reason (such as `recipient_opted_out`); any other
transport error is replaced by a generic `DeliveryError`.

Keys are 1–300 characters from `A-Za-z0-9_.:-`, containing identifiers only. Use
`createSmsPhoneDigest(AUTH_SECRET)` to identify an E.164 phone within a key, and
email's `createKeyedCommandDigest(AUTH_SECRET)` for requests containing a phone.
Never use a plain phone hash: possible numbers are enumerable. Remembered results
contain identifiers and safe metadata only, never phones, bodies or credentials.
Delivery records are retained permanently and excluded from exports. Daily usage
is also install-local state. Exports include consent columns and outbox metadata,
excluding the body. Member erasure clears consent and normalized numbers, including
the household's when its last member is erased.

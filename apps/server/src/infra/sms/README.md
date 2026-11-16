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
`recipient_opted_out` reason. Raw replies, request content and error causes are
never exposed by the adapter.

`createSmsResolver({ key, tenancy, scope, demo, clock, fetch })` in
`areas/settings/sms.ts` reads only the requested gym's encrypted config and returns
`{ gymId, name, sms }`, or null. `status` reports unreadable secrets, through the
same safe reporting path as SMTP. There is no install-wide fallback. A custom
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
  failures and unknown outcomes retain their slots conservatively. `refused`
  counts attempts suppressed by the cap. Retries of accepted delivery keys do
  not enter this wrapper or consume another slot.

Suppression reasons are `disabled`, `no_provider`, `no_consent`, `phone_changed`
and `cap_reached`; logs hold event, gym ID, member IDs and reason only. A 21610
clears both member consents and household notices consent at that E.164 number
in this gym, in one transaction, incrementing revisions and auditing each record
with source `provider`. It remains a definite non-send.

`createSmsDeliveries({ scope, clock })` mirrors email's `send`, `state`, `replay`,
`reserve`, `remember`, `attempt` and `release`. Reserve and remember commit with
any issued credential; attempt runs afterwards. An accepted or unknown key never
sends again. In-flight attempts conflict; after twice the adapter deadline (one
minute), an unresolved attempt reads as unknown. Only a definite non-send permits
a new attempt. Outcome writes retry three times without resending, guarded by
attempt number and state. Builder failures release their reservation. A transport's `SmsDeliveryError`
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

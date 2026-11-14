<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Email

`SmtpEmail` sends staff/security email through configured SMTP. `security` defaults to required STARTTLS; `tls` uses implicit TLS, and explicit `plain` supports a local mail capture server. Certificate validation stays enabled. Configure `host`, `port`, `from`, optional `auth` and default `replyTo`; an individual message can override `replyTo`. `verifyConnection()` authenticates without sending; `verifyTestSend(message)` verifies and delivers caller-supplied translated test content. `close()` ends any session still open; its pending call rejects as its stage classifies (below). Delivery failures reject for the caller/job to handle; the transport never retries on its own.

With `publicHostOnly`, for a server a tenant named, each session resolves the host once (`smtp-host.ts`), refuses it unless every address is public, and connects to the addresses it checked in turn (IPv4 first, leaving out a family the machine has no interface for, unless that leaves none), moving on only when a connection fails before login, within the one session deadline; Nodemailer gets each address, so it can't resolve the name again, and the name as the TLS server name, so the certificate is still checked against it. IPv4-mapped IPv6 addresses and anything else outside global unicast are refused.

This check is used for gym-supplied servers in `multi` mode. It queries A and AAAA
with a per-session `dns.promises.Resolver`, outside the shared worker pool, and
cancels outstanding queries at the ten-second deadline or when either query fails.
An absent address family is allowed; other DNS errors fail the check. Address
literals are checked directly without DNS. Single-gym installs retain Nodemailer's
existing lookup behavior, including system lookup support for hosts-file names.

`EmailMessage.listUnsubscribe` optionally carries one absolute HTTPS URL of at most 2,048
characters as sent (after percent-encoding), with no user name or password. Whitespace
(including CR/LF), controls and angle brackets are refused with
`DeliveryError('not_accepted', ...)` before SMTP connects, including setup test sends.
`SmtpEmail` uses Nodemailer's `list.unsubscribe` option for `List-Unsubscribe: <url>` and a
fixed internal `List-Unsubscribe-Post: List-Unsubscribe=One-Click` header. Nodemailer's list
option wraps values as URLs, so it cannot represent the latter's literal value. No caller
can supply arbitrary headers. Both headers are absent when the field is omitted.
`MemberEmail` validates this field before reading settings or preferences, even for
an opted-out member, and passes it through unchanged; `FakeEmail` validates and records it.
The demo `OutboxEmail` validates it, then deliberately drops transport headers: its stored
HTML and text remain the complete in-app preview, and it never contacts SMTP.

## Delivery errors

A failed send rejects with `DeliveryError`, whose `acceptance` (also its `code`, which structured logs and job rows record) is `not_accepted` or `unknown`. `not_accepted` is proof that no recipient received the message; everything else is `unknown`, and `deliveryAcceptance(error)` returns `unknown` for any error that is not a `DeliveryError`. Messages never quote recipients or server replies; the original Nodemailer error is the `cause`.

Nodemailer reports a lost socket or a timeout as command `CONN` in every phase, including after the message body, so its error alone cannot prove a non-send. `SmtpEmail` therefore runs each session itself through Nodemailer's `SMTPConnection` (Nodemailer still composes the message) and classifies by the stage reached:

| Failure | Acceptance |
| :--- | :--- |
| Invalid header or message composition, before connecting | `not_accepted` |
| DNS, a host refused by `publicHostOnly`, refused or failed connection, greeting, TLS or STARTTLS, authentication | `not_accepted` |
| Sender, every recipient or the DATA command refused (`EENVELOPE`), or a local size/TLS check before MAIL FROM | `not_accepted` |
| A 4xx/5xx reply to the end of the message body (the server took no responsibility, RFC 5321) | `not_accepted` |
| Connection lost or timed out once MAIL FROM is sent, including a lost acknowledgement of the body | `unknown` |
| Accepted for some recipients and refused for others (partial acceptance) | `unknown` |

`MemberEmail` raises `not_accepted` when one of its checks fails, since all of them finish before the transport is called. The demo `OutboxEmail` raises `not_accepted` when its capture transaction fails, since it then stores nothing. `FakeEmail.respondNext(error)` lets tests inject either kind.

## Durable send state

`state(tx, gymId, key)` reads within an existing scoped transaction, using the same
injected clock and stale-in-flight classification as `state(gymId, key)`. Announcements
use it while holding their reservation lock, without opening a nested transaction.
The `(gym_id, command_digest)` index supports duplicate-destination checks.

`createEmailDeliveries({ scope, clock }).send(gymId, key, email, message)` sends at most one message per gym and idempotency key. It first commits the key as `sending` in `email_deliveries` (gym-scoped, forced row-level security), then calls the transport outside any transaction, then records `accepted` (sent), `not_accepted` (suppressed, or a `not_accepted` DeliveryError) or `unknown` (any other failure) in a new short transaction. A later call returns `{ status: 'skipped', state }` without sending when the key is `accepted` or `unknown`, and sends again only after `not_accepted`; a compare-and-set on the attempt count keeps a stale attempt from overwriting a newer one. `state(gymId, key)` reads the current state.

A `sending` row younger than `emailInFlightMs` (ten minutes, twice the hard deadline `SmtpEmail` puts on every session, `smtpSessionLimitMs`) belongs to an attempt still in flight, for example after a worker lost its lease: `send` rejects with a `not_accepted` DeliveryError so the caller's job retries and finds the real outcome. An older `sending` row is a crash in flight and reads as `unknown`, as does one whose outcome write failed. `send` also rejects with `not_accepted` when its reservation fails, since the transport was never called. Keys are 1 to 300 characters of identifiers only, never personal data. A staff notice with one key per recipient adds `recipientDigest(address)`; a member's address never goes into a key, and a request that names one uses a keyed digest (below), because anyone holding the table or a backup could test a guessed address against a plain hash. A member notice has one recipient, so its key needs no address.

Rows are kept: they are the final guard against resending once job rows or their idempotency keys are gone. Any retention policy for jobs must leave `email_deliveries` alone, including the `billing.alerts.send` keys. The table is install-local operational state and is not part of gym exports. The one exception is login links (`auth.login_link:` keys, `infra/auth/delivery.ts`), written for each request from a public endpoint: once the five-minute link has expired its key guards nothing.

`createEmailDeliveryJobs()` exports `email.deliveries.upkeep`, which runs `upkeep(gymId)` hourly for each gym. The runtime registers it directly in `core/runtime.ts`. It deletes only the gym's `auth.login_link:` rows last updated more than `emailInFlightMs` ago, so their links have expired and no attempt is in flight. Every other delivery row stays; member notices use their ID-only keys directly.

`createKeyedCommandDigest(AUTH_SECRET)` is `commandDigest` as an HMAC under a key derived from the install's `AUTH_SECRET`, prefixed `k1:`. Emailed portal invitations use it, since their request names the invitee's address. An install that changes `AUTH_SECRET` refuses a replay of a generation sent before the change as another request; a deliberate resend works. Announcements and cancellation notices keep a plain `commandDigest` of the address they went to, so one address gets each message once; a member's erasure clears the erased member's (`areas/announcements/README.md`).

A send command that issues a credential (a one-off signed link, a staff or portal invitation) uses the parts of `send`, so the credential and the reservation commit together. `replay(tx, gymId, key, digest)` runs first: it returns the command's remembered result when an attempt was accepted or may have been (with `outcome: unknown` for an uncertain attempt), nothing when the command hasn't run or was definitely not sent, and a `conflict` when an attempt is in flight or the generation was used for another request (`commandDigest`). Then, in the transaction that issues the credential, `reserve` takes the key and `remember` stores what a replay returns (identifiers and metadata, never a credential), in the row's `command_digest` and `command_result`. After that transaction, `attempt` calls the transport and records the outcome (given a message builder instead of a message, it releases the reservation when the builder throws), or `release` records `not_accepted` when a last-moment check stopped it before the transport. A crash after the commit reads as `unknown`, like any other: the replay returns the credential and sends nothing, and only a deliberate resend, which has a new generation, sends again. Printed invitations send nothing and take no generation. The email response contracts carry an optional `outcome: "unknown"` in `data`; it is present only on uncertain replays. The send forms explain that an earlier email may have arrived and offer **Send again** as a deliberate new generation. They keep each pending generation in tab-local `sessionStorage`, keyed by form and request identity, until a confirmed response or that deliberate resend; when browser storage is unavailable they retain it in memory.

Persisted billing notices use `reserve(tx, gymId, key)` without a command digest: an accepted or uncertain notice returns no reservation, an in-flight one conflicts, and a definite non-send can try again. Dunning reserves its key, creates both links and remembers their IDs in one transaction, before rendering or calling SMTP. A failure before that transaction commits rolls back both links and the key. A definite non-send revokes the links; a possibly delivered one retains them and never mints another pair for the same notice. The reservation also covers a crash after commit but before SMTP: that attempt ages into uncertain and a retry conservatively keeps its links, since it cannot prove whether the email was delivered.

Outcome writes are not swallowed. `release` rejects on a failed write so the caller can report or retry it. `attempt` preserves the transport acceptance classification when recording fails: an accepted email with an unrecorded outcome reports `unknown`, and a proven non-send still reports `not_accepted`.

Member notifications must use `new MemberEmail({ gymId, memberId, email, settings })`, which implements the same `Email` interface. Inject the gym-settings accessor and, in tests, scoped `forGym`. It reloads the go-live switch and member flags before each send and finishes both reads before SMTP. Suppression priority is disabled, opted out, then undeliverable. The frozen schema represents undeliverability as `emailDeliverable === false`. Missing/cross-gym members or mismatched recipients fail closed. The recipient is the member's stored email (one plain address). Staff login and setup test messages use the unwrapped transport, so the member switch cannot prevent account recovery.

Suppression logs contain only event, gym ID, member ID and reason; by default they go through the structured logger (`core/log.ts`); provide `logSuppression` to route them elsewhere. No recipient, credentials, rendered body or subject is logged. The wrapper also works around `FakeEmail` or a capture transport.

Shared React Email components live in `emails/_shared`. `renderEmail` returns the registry's `RenderedEmail` with HTML and plain text derived from the same render. Pass the feature translator and keys for the subject, preview, footer, headings, text and buttons; the shared layout has no fixed English copy. Build templates with React `createElement` in `.ts` files, or JSX where the caller's compiler supports it.

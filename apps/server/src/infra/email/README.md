<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Email

`SmtpEmail` sends staff/security email through configured SMTP. `security` defaults to required STARTTLS; `tls` uses implicit TLS, and explicit `plain` supports a local mail capture server. Certificate validation stays enabled. Configure `host`, `port`, `from`, optional `auth` and default `replyTo`; an individual message can override `replyTo`. `verifyConnection()` authenticates without sending; `verifyTestSend(message)` verifies and delivers caller-supplied translated test content. `close()` ends any session still open; its pending call rejects as its stage classifies (below). Delivery failures reject for the caller/job to handle; the transport never retries on its own.

## Delivery errors

A failed send rejects with `DeliveryError`, whose `acceptance` (also its `code`, which structured logs and job rows record) is `not_accepted` or `unknown`. `not_accepted` is proof that no recipient received the message; everything else is `unknown`, and `deliveryAcceptance(error)` returns `unknown` for any error that is not a `DeliveryError`. Messages never quote recipients or server replies; the original Nodemailer error is the `cause`.

Nodemailer reports a lost socket or a timeout as command `CONN` in every phase, including after the message body, so its error alone cannot prove a non-send. `SmtpEmail` therefore runs each session itself through Nodemailer's `SMTPConnection` (Nodemailer still composes the message) and classifies by the stage reached:

| Failure | Acceptance |
| :--- | :--- |
| Invalid header or message composition, before connecting | `not_accepted` |
| DNS, refused or failed connection, greeting, TLS or STARTTLS, authentication | `not_accepted` |
| Sender, every recipient or the DATA command refused (`EENVELOPE`), or a local size/TLS check before MAIL FROM | `not_accepted` |
| A 4xx/5xx reply to the end of the message body (the server took no responsibility, RFC 5321) | `not_accepted` |
| Connection lost or timed out once MAIL FROM is sent, including a lost acknowledgement of the body | `unknown` |
| Accepted for some recipients and refused for others (partial acceptance) | `unknown` |

`MemberEmail` raises `not_accepted` when one of its checks fails, since all of them finish before the transport is called. `FakeEmail.respondNext(error)` lets tests inject either kind.

## Durable send state

`createEmailDeliveries({ scope, clock }).send(gymId, key, email, message)` sends at most one message per gym and idempotency key. It first commits the key as `sending` in `email_deliveries` (gym-scoped, forced row-level security), then calls the transport outside any transaction, then records `accepted` (sent), `not_accepted` (suppressed, or a `not_accepted` DeliveryError) or `unknown` (any other failure) in a new short transaction. A later call returns `{ status: 'skipped', state }` without sending when the key is `accepted` or `unknown`, and sends again only after `not_accepted`; a compare-and-set on the attempt count keeps a stale attempt from overwriting a newer one. `state(gymId, key)` reads the current state.

A `sending` row younger than `emailInFlightMs` (ten minutes, longer than any session the transport allows) belongs to an attempt still in flight, for example after a worker lost its lease: `send` rejects with a `not_accepted` DeliveryError so the caller's job retries and finds the real outcome. An older `sending` row is a crash in flight and reads as `unknown`, as does one whose outcome write failed. `send` also rejects with `not_accepted` when its reservation fails, since the transport was never called. Keys are 1 to 300 characters of identifiers only, never personal data; hash an address into a key when one key per recipient is needed.

Rows are kept permanently: they are the final guard against resending once job rows or their idempotency keys are gone. Any retention policy for jobs must leave `email_deliveries` alone, including the `billing.alerts.send` keys. The table is install-local operational state and is not part of gym exports.

Member notifications must use `new MemberEmail({ gymId, memberId, email, settings })`, which implements the same `Email` interface. Inject the gym-settings accessor and, in tests, scoped `forGym`. It reloads the go-live switch and member flags before each send and finishes both reads before SMTP. Suppression priority is disabled, opted out, then undeliverable. The frozen schema represents undeliverability as `emailDeliverable === false`. Missing/cross-gym members or mismatched recipients fail closed. The recipient is the member's stored email (one plain address). Staff login and setup test messages use the unwrapped transport, so the member switch cannot prevent account recovery.

Suppression logs contain only event, gym ID, member ID and reason; provide `logSuppression` to integrate structured logging. No recipient, credentials, rendered body or subject is logged. The wrapper also works around `FakeEmail` or a capture transport.

Shared React Email components live in `emails/_shared`. `renderEmail` returns the registry's `RenderedEmail` with HTML and plain text derived from the same render. Pass the feature translator and keys for the subject, preview, footer, headings, text and buttons; the shared layout has no fixed English copy. Build templates with React `createElement` in `.ts` files, or JSX where the caller's compiler supports it.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Signed links

`createSignedLinksService` implements creation, metadata reads, sending, revocation,
token resolution, and single-use completion. Inject `scope` and `clock` for tests.
Every mutation and its redacted audit commit in one short gym transaction. Concurrent
completion and revocation lock the same link row; a second completion fails.

Creation returns a fresh 256-bit URL-safe token once. Only its SHA-256 digest is
stored. Get, list, revoke, and send return metadata without the token or digest.
The HTTP creation result and metadata responses use `Cache-Control: no-store`.

`createMany(context, requests)` creates several links in one transaction, all or none,
and returns each `{ link, token }` in request order; `create` is the one-link case.
`createSignedLinksIn(tx, context, requests, now)` does the same inside a caller's
transaction (campaign creation). Every request is checked before anything is inserted:
one query per resource kind (households, invoices, waiver members, campaigns) and per
500 IDs, with waiver members locked in ascending ID order across the whole request. A
resource repeated in one call is refused first, with the contract's "may appear only
once" message. After that, the first failing request gets the error a one-by-one check
would give; a past expiry is found before any lookup. Request IDs are compared in
lowercase, as PostgreSQL compares UUIDs. Links and their `signed_link.created` audits then go in as two multi-row inserts
per 500 requests, with IDs ascending in request order. Rows, audits, tokens and digests
match one-by-one creation, except that every link and audit of a call shares one
`createdAt` / `occurredAt`.

`resolve(gymId, token)` returns `active` with a `SignedLinkPrincipal`, or `not_found`,
`used`, `revoked`, or `expired`. When multiple conditions apply, used takes precedence,
then revoked, then expired, matching the campaign contract. Expiry includes equality.
The principal's resource fields are display metadata. Signed-link page handlers must
use `forHousehold({ kind: 'signed_link', gymId, linkId, now: clock.now() }, ...)`,
which reloads and verifies the actual link in its transaction. Recheck authorization
for each operation. Call `markUsed({ gymId, linkId })` only with a verified link ID
when completing its purpose; it rejects inactive links and returns safe metadata.

Email composition supplies `configureSignedLinkDelivery({ prepare })`, or injects a
`delivery` into the service factory. `prepare(gymId)` loads the gym's canonical origin,
name, member-email switch, translator, and an `Email` transport. Origins come from
trusted configuration, never an incoming request's Host or forwarded headers. The
preparation result must carry the matching gym ID. Delivery is unavailable until
configured; no credential is created in that case.

Send creates a fresh link, commits it, then emails the household's address using the
shared email layout. The URL is `/l/<token>` on the configured origin. The household
recipient helper (`areas/members/household-recipient.ts`, shared with billing
notifications and alerts) checks matching members' opt-out and deliverability flags;
waiver sends also honor the target member's flags. No member address is substituted for a missing household
address. Suppressed sends and transport failures that prove nothing was sent revoke the undisclosed credential
and return a generic unavailable error; a possibly accepted send keeps its link usable and returns the same error. Delivery reloads the persisted member-email
switch immediately before sending, after asynchronous preparation and rendering;
the prepared value cannot authorize a send after the switch is turned off.

`POST /api/links/send` requires `sendGeneration`, a UUID naming one send command: the client keeps it
while retrying and picks a new one for a deliberate resend. The delivery key is
`links.send.<purpose>:<household>:<generation>`, and its `email_deliveries` row is reserved and names
the link in the transaction that creates the link. A replay returns that link's current metadata and
sends nothing, once the first attempt was accepted or may have been (a crash mid-send counts); while
that attempt is in flight it is a conflict, and so is a generation reused for another resource. An
attempt that provably sent nothing revokes its link, and its replay creates a new link and sends again.
The expiry isn't part of the command's identity. Campaign sends and reminders have their own
occurrence reservations (`campaigns.README.md`) and don't use a generation.
The email transport runs outside transactions.

For a positive invoice below the card minimum or off the currency step, send checks
the amount before minting and commits the new metadata record already revoked,
with creation and revocation audits. It emails manual-payment instructions without
a URL. Zero invoices refuse a send before creating a credential: they settle on
their due date. Delivery still checks the invoice amount; if it omits a URL after
a concurrent amount change, send revokes that credential too.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Signed links

`createSignedLinksService` implements creation, metadata reads, sending, revocation,
token resolution, and single-use completion. Inject `scope` and `clock` for tests.
Every mutation and its redacted audit commit in one short gym transaction. Concurrent
completion and revocation lock the same link row; a second completion fails.

Creation returns a fresh 256-bit URL-safe token once. Only its SHA-256 digest is
stored. Get, list, revoke, and send return metadata without the token or digest.
The HTTP creation result and metadata responses use `Cache-Control: no-store`.

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
shared email layout. The URL is `/l/<token>` on the configured origin. Matching
members' opt-out and deliverability flags are checked; waiver sends also honor the
target member's flags. No member address is substituted for a missing household
address. Transport failures and suppressed sends revoke the undisclosed credential
and return a generic unavailable error. Delivery reloads the persisted member-email
switch immediately before sending, after asynchronous preparation and rendering;
the prepared value cannot authorize a send after the switch is turned off.
The email transport runs outside transactions.

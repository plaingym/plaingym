<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# QR check-in

`createCheckinCodeService` re-derives a member's code using the gym's encrypted
random key through `createGymKeyResolver`. The HMAC input separates the check-in
purpose, gym, member and version. Only lowercase SHA-256 hashes are persisted.
Reads never issue or reactivate codes. Staff create/replace and revoke actions
increment the version and revision and audit only version metadata. Erased
members cannot read, change or use codes.

`createQrCheckin` authenticates the code for one member, evaluates the same
inactive/waiver/billing standing providers as name/PIN check-in, and records
through the attendance service. Every session selection authenticates the QR
again. Explicit `null` means open mat; omitted session IDs select exactly one
current booked class or prompt for a choice. Unknown or blocked codes return
only `see_front_desk`. Successful identities contain first name, last initial
and an optional short-lived photo link. No private standing details or amounts
are returned.

The route barrels already include both route parts. Production composition must
call `configureCheckinCodes({ gymKey })` and
`configureQrCheckin({ codes: createCheckinCodeService({ gymKey }), uploadsFor,
bookedSessions })`, using the runtime's existing gym-key resolver. Without that
configuration, issuing codes fails closed. The booking adapter accepts the gym,
member and current candidate session IDs and returns only booked IDs. Until it
is injected, omitted session IDs always prompt; tests cover a booking fake.

The additive staff read/replace/revoke endpoints live in the local
`members/checkin-code.contracts.ts` pending publication of the shared contract.
They require `members.manage`. Device tokens remain restricted by the existing
kiosk middleware to check-in endpoints and cannot access these staff routes.

The pre-registered `memberTabs.checkin-code` tab is enabled. Mount the exported
`QrCheckin` web component on the kiosk's search screen with the existing device
token and unauthorized callback. Its camera stays off until a user starts it;
native `BarcodeDetector` is preferred, with local `jsqr` 1.4.0 (Apache-2.0)
fallback. Frames are never uploaded. Results reset after eight seconds, and
unfinished scans and session choices after sixty seconds. Codes stay in memory
only and are cleared with the result. Camera tracks and polling stop on exit.
The staff tab renders codes using `qrcode` 1.5.4 (MIT), with
`@types/qrcode` 1.5.6 for development.

Tests exercise the actual area route registrations with device middleware,
staff permission matrices, gym/household isolation, revocation and regeneration,
revision races and the restore maintenance `rekey` path. Scanner tests decode a
real generated QR with the fallback and cover camera errors and cancellation.

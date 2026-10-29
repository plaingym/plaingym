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

Production composition configures the staff and kiosk services with the existing
encrypted gym-key resolver and photo storage. Both QR and name/PIN check-in use
`kiosk/checkin.ts` for private identities, current sessions, the real
`class_bookings` query (`booked` only), and attendance recording. Exactly one
booked current session is selected automatically; several offer only booked
sessions, while zero offers all current sessions. Open mat is never deduplicated.

The staff read/replace/revoke endpoints use the shared check-in-code contracts
and require `members.manage`. Device tokens remain restricted by the existing
kiosk middleware to check-in endpoints and cannot access these staff routes.

The registered `memberTabs.checkin-code` staff tab and the kiosk search screen
are mounted. The camera stays off until a user starts it;
native `BarcodeDetector` is preferred, with local `jsqr` 1.4.0 (Apache-2.0)
fallback. Frames are never uploaded. Results reset after eight seconds, and
unfinished scans and session choices after sixty seconds. Codes stay in memory
only and are cleared with the result. Camera tracks and polling stop on exit.
The staff tab renders codes using zero-dependency `uqr` 0.1.3 (MIT).

Tests exercise the actual area route registrations with device middleware,
staff permission matrices, gym/household isolation, revocation and regeneration,
revision races and the restore maintenance `rekey` path. Scanner tests decode a
real generated QR with the fallback and cover camera errors and cancellation.

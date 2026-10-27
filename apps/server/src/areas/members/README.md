<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Members and households

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
and dates stay), deletes the member's signed waivers and their signature images,
removes tag and member-login links, revokes
member-specific signed links, cancels the member's memberships (in the same
transaction, so an erased member is never billed again), and clears the household
PIN. When the household
has no remaining identifiable members, its contact details and remaining portal
and signed-link access are also removed. Other household members remain intact.
Erasure cancels booked and waitlisted class places under each session's row lock,
clears their waitlist positions without renumbering others, and unlinks staff
profiles from the erased member. For a household's last member it also revokes
active cards, clears the local Stripe customer ID and holds open and past-due
invoices for review. `eraseMember` returns `files` and `revokedCards` for storage
cleanup and provider detachment after commit. The route accepts the billing
detach callback and retry queue through `configureMembers`.
Unused households can be deleted; referenced households return a conflict.

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

`createMemberPhotoJobs` reconciles uploads left by failed or interrupted requests.
Before retiring an unreferenced key it locks the member and advances its revision,
invalidating an unfinished attachment's compare-and-set. The one-hour age filter
avoids interrupting normal uploads; correctness comes from this revision change.
Actual deletion remains the storage subsystem's backup-aware sweep.

## Composition

The runtime calls `configureMembers({ pinSecret, uploadsFor, clock })` and registers
`createMemberPhotoJobs(uploadsFor)` with the worker, using its gym-scoped uploads
resolver. Until `configureMembers` runs (or when a test passes its own service without
storage), photo operations and setting a nonempty PIN fail closed. The web feature
registration enables the Members nav entry; the profile renders every enabled,
permitted `memberTabs` registration.

Every JSON endpoint uses the shared `membersContracts`, including household and tag
deletion, a member's assigned tags, and photo upload. The photo read
(`GET /api/members/{memberId}/photo`) returns the image bytes, so it is declared in
`members.routes.ts` rather than as a JSON contract. The household login contracts
(`listHouseholdUsers`, `createHouseholdUser`, `revokeHouseholdUser`) are not
implemented here.

## Verification

`members.test.ts` uses a real PostgreSQL database and exercises every implemented
route for all staff roles, foreign-gym resource IDs, and non-staff principals
(household payers/adults, signed links, kiosks and anonymous requests). It also
covers revision races, tag filtering, PINs, anonymization with retained accounting
and attendance rows, and photo storage/cleanup.

The gate is `pnpm check-types`, `pnpm lint`, `pnpm test` and `pnpm compliance`.

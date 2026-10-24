<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Staff profiles and management

Profiles are presentation records; they can exist without a login and do not grant access. Owner/admin management routes use the shared staff contracts. All writes recheck the caller's stored role, use the request clock, and audit in the same transaction. Profile edits and role changes/revocations require the current revision. Owners cannot be granted, changed, or revoked here. Admins can manage other admins, as allowed by `staff.manage`; password resets retain the stricter protected-account rules in the existing auth service.

Account IDs supplied to role grants must already belong to this gym through a household, profile, or role. Profile account links require an existing staff role. Member links are checked through gym-scoped queries. Lists are paginated and contain no email addresses or invitation secrets.

Invitations provision identity through the account service and return the role required by the invitation contract. The auth invitation store writes only authentication tables; staff-role validation, profiles, and audits stay in the staff service. The store persists a SHA-256 digest of a random 256-bit token in `auth_verification`, with the gym in its identifier and the role ID, role name, user ID and revision in its value. Tokens expire after seven days. Changing/revoking the role invalidates the invitation. Resending replaces outstanding links; a delivery failure can be retried. Accepted staff accounts cannot be reinvited to bypass password-reset protection.

The public acceptance page reads a URL fragment, removes it from browser history, and submits it as JSON. Consumption, profile creation, credential installation and audit commit atomically. Password hashing/verification happens outside transactions. Existing passwords must be proved and are never replaced. Multi mode accepts no password. Accepting a link does not create a session; the invitee signs in through the normal login flow.

Photos are resized and re-encoded to JPEG in the browser (at most 512 pixels per side). `POST /api/staff/profiles/{staffProfileId}/photo` takes JSON `{ revision, contentType, base64 }`, checks raster bytes with the members photo validator, and bounds the decoded upload to 512 KiB. It writes a fresh key under `<gym>/staff/<profile>/`, attaches it with a revision check and audit, and marks failed, replaced, or cleared objects for deferred deletion outside transactions. Ordinary create/update requests refuse photo-key strings; updates may send `photoKey: null` to remove a photo. `GET` at the same path resolves the current photo from the gym-scoped profile, never a caller-supplied storage key. Reads are uncached and set `nosniff`. Bytes never enter PostgreSQL.

The profile form saves the presentation fields before its separate photo request. If upload fails after a successful profile save, the form retains the saved profile ID and revision, so retrying cannot create another profile. Conflicting profile edits retain the entered values for review.

## Integration

The staff barrel exports every profile, role, invitation, acceptance-page, and photo route. Every route returns 503 until `core/runtime.ts` calls `configureStaffProfiles` with an invitation service (the runtime's auth config, SMTP check, and the gym's SMTP mailer or the demo outbox), the gym's upload provider, and the canonical origin resolver. Demo mode keeps uploads disabled.

The JSON contracts live in `packages/shared`: `staffContracts.uploadPhoto` and the public `staffInvitationContracts.acceptInvitation`. The photo read and the `/staff-invitation` page are binary and HTML responses outside the JSON contracts. Ordinary profile requests cannot carry a photo key; an update may only clear one with `photoKey: null`. The password reset backend remains the existing staff-auth route; only its UI is added.

## Validation

Run `pnpm test`. The repository setup starts disposable PostgreSQL and clones a fresh migrated database per integration test file. Staff coverage includes every route's role permissions, cross-gym records and links, stale revisions, photo replacement/clear and losing-write cleanup, token replay/expiry/concurrent consumption, printed/password and SMTP/email flows, existing credential protection, OpenAPI registration, missing runtime configuration, generated-client transport, and browser workflows.

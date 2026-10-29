<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Member authentication and household access

Members use the same Better Auth endpoints as staff. The auth middleware checks
the session's issuing gym before loading a principal. `createPortalPrincipalLoader`
loads staff roles first; a staff identity remains staff even when it is also
linked to a household. Otherwise it selects the user's earliest household link
in this gym. There is no household selector in a request body.

`createMemberHouseholdContext` implements the shared context interface with a
fresh database authorization snapshot. `createPortalAuthorization` reloads that
snapshot for member permissions and uses the same not-found response for scope
denials. Resource consumers still use `forHousehold`; the context is not a raw
database handle or a substitute for the household query boundary. Revoking a
household login removes its grant immediately, including for an existing session.

Staff manage household logins with `portal_access.manage`. The original user
list/create/revoke contracts are preserved. The additional portal-login listing
includes email addresses, read through the auth module. Mutations are audited.
Member-only grants require an adult date of birth, checked in the gym's timezone;
children use their payer's household access.
Email and printed invitations expire after seven days. Tokens are random,
stored hashed in `auth_verification`, bound to gym and household-login IDs, and
placed in URL fragments. Resending a pending invitation invalidates its old token.
Claiming rechecks the link, consumes the token, and creates any password in one
transaction. An existing password must be supplied and is never replaced by a
claim. Staff identities cannot be claimed through a member invitation.

An active onboarding link can create payer access only for its own household.
The claim revalidates and locks the signed link in the provisioning transaction.
It neither consumes the onboarding link nor changes its card/waiver requirements.
The browser offers portal setup before those steps; completing the link without
claiming remains possible. In passwordless mode the member subsequently proves
their email through the shared login flow. Passwords are refused in multi mode.

Member password resets use the existing protected-account policy and terminate
the user's gym sessions. The reset route checks its household-login ID again
inside the password transaction; front desk cannot reset an account with a staff
role, and owners cannot be reset through the web interface.

Composition supplies `createPortalPrincipalLoader` to `sessionMiddleware`, mounts
with `createPortalAuthorization`, configures `configurePortalAccess` with the
invitation service and canonical gym origin, and passes the same invitation
service to `configureLinkPages`. Email delivery uses the gym SMTP resolver.
Tests exercise these exports with real PostgreSQL and the real registrations.

The PWA manifest, generated PNG icons and service worker are public assets.
The worker has no fetch handler and stores no offline caches. Portal API responses
are private and uncached; the portal needs an internet connection.

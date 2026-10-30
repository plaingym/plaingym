<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Member authentication and household access

Members use the same Better Auth endpoints as staff. The auth middleware checks
the session's issuing gym before loading a principal. `createPortalPrincipalLoader`
loads staff roles first; a staff identity remains staff even when it is also
linked to a household. Otherwise it chooses one household link in this gym:

* with one usable link, that household;
* with several, the household stored with this session, if the user still has
  a link to it;
* otherwise none: the user keeps a signed-in session with no access, loaded as a
  staff principal with no roles. The admin then explains that the login has no
  staff access instead of showing the login form again, and a user with several
  households gets the portal's household picker.

No request body or parameter supplies the household scope, and the portal never
shows several households at once.

## Choosing a household

`GET /api/portal/households` lists the signed-in user's own household links in
this gym (name and role) and the household the current request resolved to.
`POST /api/portal/households/current` stores a choice with the session
(`auth_session.household_id`, through `createPortalSessionStore`). It accepts only
a household the user is linked to in this gym, refuses staff identities, and is
audited. The choice is a preference, not a grant: every request rechecks it
against the user's current links, so revoking the chosen link returns the user to
the picker, or straight into the remaining household when only one is left. Each
session keeps its own choice. Both routes need a gym-bound session and answer 401
without one.

`createMemberHouseholdContext` implements the shared context interface with a
fresh database authorization snapshot. `createPortalAuthorization` reloads that
snapshot for member permissions and uses the same not-found response for scope
denials. Resource consumers still use `forHousehold`; the context is not a raw
database handle or a substitute for the household query boundary. Revoking a
household login removes its grant immediately, including for an existing session.

## Staff management and invitations

Staff manage household logins with `portal_access.manage`. The original user
list/create/revoke contracts are preserved. The additional portal-login listing
includes email addresses, read through the auth module. Mutations are audited.
Member-only grants require an adult date of birth, checked in the gym's timezone;
children use their payer's household access.

Email and printed invitations expire after seven days. Tokens are random,
stored hashed in `auth_verification`, bound to the gym and to the household login
they grant, and placed in URL fragments. Resending an invitation invalidates its
old token. An invitation grants nothing by itself: the household login is created
only when the invitation is accepted. An address that already has a login for the
household, or a member who already has one, is a conflict. Staff identities cannot
be claimed through a member invitation.

The household's Portal access tab lists its outstanding invitations: the invitee's
address, the access granted (whole household or one member) and the expiry.
`GET /api/households/{householdId}/portal-invitations` reads them through the auth
module, scoped to the gym and to the household in the route. An invitation that has
expired or been accepted is no longer listed, and neither a token nor its hash is
ever returned. Staff with `portal_access.manage` revoke one with
`DELETE /api/households/{householdId}/portal-invitations/{invitationId}`, which deletes
it and writes a `household_user.invitation_revoked` audit event in the same
transaction. Accepting a revoked invitation fails as for an expired one, whether the
invitee holds the link or a claim code already sent. An invitation of another
household or gym, an expired one, and any other verification row answer 404.

Acceptance proves the account before linking it:

* **Password login:** the claim page asks for a password. An existing password
  must be supplied and is never replaced; a new account sets one. The token is
  consumed, the login created and any password set in one transaction.
* **Without password login:** email and printed invitations alike send a login
  link to the invited address. The household login is created on that link's
  callback, for the signed-in user the invitation names, while the invitation is
  still valid; completing consumes it.

## Joins awaiting confirmation

A password-mode join provisions no account (`public/pages/join.md`). Its completion calls
`requestPortalConfirmation`, an audited system marker on the household that holds no contact
details. Until the household has a payer login, the portal-login listing returns
`awaitingConfirmation` with the household's current address, and the staff panel offers to
confirm it. Staff check the person, then issue the printed payer invitation for that address;
the person sets the password, or proves an existing one, on `/portal/claim`. An invitation that
expires or is lost leaves the household awaiting, and printing again replaces it; revoking
the payer login later offers confirmation again. A household without an address, such as an
erased one, never awaits confirmation. Staff accounts are refused as for any invitation.

Password-mode installs have no mail to tell staff, so the dashboard does: the
`members.portal-confirmations` widget (`household-users.widget.ts`, for staff with
`portal_access.manage`) counts the households awaiting confirmation and lists up to
twenty by name, each linking to the Portal access tab of its first member. It holds no
address, and the dashboard hides it while nothing is waiting. A household with no
member left to open, such as one whose members were all anonymized, isn't listed.

## Onboarding links

An active onboarding link can create payer access only for its own household.
It neither consumes the onboarding link nor changes its card/waiver requirements.
The browser offers portal setup before those steps; completing the link without
claiming remains possible. With password login, the password proves the account
(an existing account's password must match) and the claim revalidates and locks
the signed link in the transaction that creates the login. Without password login,
the claim provisions the account if needed, links nothing, and emails a login link
to the address entered. The payer login is created on its callback, for the
signed-in user with that address, only while the onboarding link is still active
and unused. Passwords are refused in multi mode, and staff accounts are refused.

## Claim callbacks

Passwordless claims carry no stored pending state. The login link's callback is
`/portal/claim?claim=<code>`, a stateless code signed with a key derived from
`AUTH_SECRET` that names the gym, the user and the onboarding link or invitation,
and expires after an hour (never later than what it names). The magic-link
verification accepts no other destination besides the admin. The claim page posts
the code to `POST /api/portal/claims/complete`, which requires the signed-in
session of the user the code names in the same gym, rechecks the onboarding link
or invitation under a row lock, refuses staff identities, creates the household
login, audits it, and opens that household for the session.

Member password resets use the existing protected-account policy and terminate
the user's gym sessions. The reset route checks its household-login ID again
inside the password transaction; front desk cannot reset an account with a staff
role, and owners cannot be reset through the web interface.

## Composition

Composition supplies `createPortalPrincipalLoader` to `sessionMiddleware`, passing
the verified session so the loader sees its chosen household; mounts with
`createPortalAuthorization`; configures `configurePortalAccess` with the
invitation service and canonical gym origin; and passes the same invitation
service to `configureLinkPages`. The invitation service's `loginLink` sends the
claim login links through the auth service's `sendLoginLink`. Email delivery uses
the gym SMTP resolver. Tests exercise these exports with real PostgreSQL and the
real registrations.

The PWA manifest, generated PNG icons and service worker are public assets.
The worker has no fetch handler and stores no offline caches. Portal API responses
are private and uncached; the portal needs an internet connection.

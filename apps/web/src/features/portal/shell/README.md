<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal shell

The portal first loads the signed-in user's households. A login with one
household goes straight in; a login with several sees a household picker and,
once one is chosen, a switcher in the header. Choosing or switching stores the
household with the session on the server, resets the portal (cancelling its loads in flight, then
clearing every cached query under `['portal']` and waiting for the household lists it refetches), asks
for the bootstrap again and returns to the portal home without waiting for that refetch, so data from
two households is never shown together. The reset reaches only `['portal']`: the bootstrap, the shell's
own entries and root queries such as demo discovery stay. The previous household's context query is
removed rather than refetched, and a context answer for a household other than the one its key names is
never stored (the household lists are read again instead). Once the server has stored the switch, a later
step that fails (the reset, going home) doesn't report a failed switch: the portal shows the new household.
Whenever the open household changes any other way, such as the server falling back to another one
because a link was revoked, the shell does the same: it resets the portal (keeping the household lists
it was just told about) and refetches the bootstrap, so the pages and the name follow it. The household
the name was last settled for is kept in the query cache, not in the layout, so a layout that remounts
(or whose household lists were collected) still notices a change made while it was away.
From a change until the bootstrap refetch it asks for has finished, and after one that fails, the header
shows the generic "Signed in" label, never the previous household's name beside the new scope.
The header shows the gym's name and, under it, the signed-in person's name and their
scope in the open household (account holder or member), so switching logins or
households never loses track of who is signed in; a long name truncates, the scope stays.
The portal then reads the authenticated context and renders enabled `portalNav`
contributions using the current member role. The shared login page handles sign-in.
The invitation page consumes its fragment token in memory and removes it from
the address bar. With password login it asks for a password; without it, accepting
emails a sign-in link to the invited address. That link, and the one sent by an
onboarding claim, returns to `/portal/claim?claim=<code>`, which completes the
claim for the signed-in user, removes the code from the address bar and opens the
portal. Signing out clears the query cache before returning to login.
The root layout supplies the source-code footer.

The portal-access member tab supports email or printed invitations, revocation,
and protected password resets when password login is enabled. Server permissions
are authoritative. A printed URL is displayed in full with wrapping so it remains
readable on paper.

Browser checks use the built web app and isolated API fixtures, while server tests
cover real authentication and database isolation. After `pnpm build` and installing
the pinned `e2e/` dependencies, run from the repository root:

```sh
node apps/server/node_modules/tsx/dist/cli.mjs apps/web/src/features/portal/shell/tests/browser-check.ts
```

The check uses headless Edge with an isolated temporary profile, checks 360 px and
1280 px, axe A/AA, touch targets, the household picker and header switcher,
invitations and resets, and Chromium's manifest
and installability checks. Screenshots are saved under `coverage/portal/browser`.
It closes its server/browser and removes the temporary profile on completion.

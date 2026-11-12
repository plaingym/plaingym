<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal shell

The portal first loads the signed-in user's households. A login with one
household goes straight in; a login with several sees a household picker and,
once one is chosen, a switcher in the header. Every portal query is keyed by the open household
(`['portal', gym, user, 'household', householdId, ...]`, built by `usePortalScope` in `household/api.ts` from the
household lists; the shell keeps its own context under a reserved `shell` segment no page key uses), so one household's cached pages can't be reached from another's. Choosing or switching
stores the household with the session on the server, then writes it into the cached household lists (after
cancelling a list load that began before the switch) and removes every other household's cached queries,
which also cancels their loads in flight. It then reads the lists again, asks for the bootstrap again and
returns to the portal home without waiting for that refetch. Every portal answer names the household the server read it for. An answer, the shell's context or a
page's, for a household other than the one its key names is never stored (the household lists are read again instead).
A page shows loading during a recovery it started, with its forms and signatures still mounted. One the shell started leaves the page on screen until the lists answer.
A failed recovery keeps the draft. A confirmed move resets the page's local state
and shows a notice to review the household and unfinished work, including on the household
picker after a revoked link. Recovery rereads a stale in-flight list answer until
it has made a fresh attempt to reach the conflict's household; a second mismatch
fails without looping. Portal 404s also refresh the household lists.
Portal writes name their page household in
`X-Portal-Household`; the server rejects a stale or absent household before the handler,
and a stale page refreshes the lists without showing a saved result or following Checkout.
The context names its household once, in the answer's top-level `householdId`. Once the server has
stored the switch, a later step that fails (the list read, going home) doesn't report a failed switch: the
portal shows the new household. The household lists, the bootstrap, the shell's own entries and root
queries such as demo discovery are not under a household's keys and stay.
Whenever the open household changes any other way, such as the server falling back to another one
because a link was revoked, the pages follow the new key at once; the shell removes the other households'
entries and refetches the bootstrap, so the pages and the name follow it. The household
the name was last settled for is kept in the query cache, not in the layout, so a layout that remounts
(or whose household lists were collected) still notices a change made while it was away.
From a change until the bootstrap refetch it asks for has finished, and after one that fails, the header
shows the generic "Signed in" label, never the previous household's name beside the new scope.
The header shows the gym's name and, under it, the signed-in person's name and their
scope in the open household (account holder or member), so switching logins or
households never loses track of who is signed in; a long name truncates, the scope stays.
Beside sign-out, **Your account** opens `/portal/account` (`features/account`), where the login sees its sign-in
email, methods and households and changes its email; the household picker has no such link.
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

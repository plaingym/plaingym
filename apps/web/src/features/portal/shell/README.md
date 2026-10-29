<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Portal shell

The portal reads the authenticated context and renders enabled `portalNav`
contributions using the current member role. The shared login page handles sign-in.
The invitation page consumes its fragment token in memory and removes it from
the address bar. Signing out clears the query cache before returning to login.
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
1280 px, axe A/AA, touch targets, invitations and resets, and Chromium's manifest
and installability checks. Screenshots are saved under `coverage/portal/browser`.
It closes its server/browser and removes the temporary profile on completion.

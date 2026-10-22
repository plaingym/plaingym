<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web shell

`App` owns the Query client and Router providers. Pass a `ShellServices` implementation to inject the gym/session projection. `createShellServices(loadBootstrap)` supplies the local auth transport; the loader must return the resolved gym, enabled modules, current session roles/member access, and enabled password/magic-link methods. The default loader fails closed until this bootstrap contract is connected. Navigation filtering is presentation only; the API must enforce permissions independently.

A successful password login clears cached data and reloads the server projection before selecting `/admin` or `/portal`. Signing out clears data and reloads `/login`. Magic links return to `/login` so the same server projection determines their destination; callback destinations never come from URL parameters.

Shell translations extend the catalog generated from `locales/loader.ts`. `createShellTranslator` accepts catalog overrides; missing keys retain the shared translator's visible-key fallback. Shell messages currently reside in `lib/shell.en.ts` within the shell's ownership boundary.

Tailwind configuration is in `styles.css`. `pnpm install` and the web build generate CSS into the ignored `node_modules/.cache/plaingym/` directory, so standalone Vite/compliance builds can resolve the input without committing generated CSS. The web dev command watches Tailwind and proxies `/api` to the local server. Set `SOURCE_URL` using the existing root environment configuration for development/builds.

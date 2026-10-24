<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web shell

`App` owns the Query client and Router providers. The default `ShellServices` loads and validates `/api/auth/bootstrap` using the shared contract: resolved gym, enabled modules, current session roles/member access, and enabled password/magic-link methods. Pass `createShellServices(loadBootstrap)` to inject an alternative loader for tests. Navigation filtering is presentation only; the API enforces permissions independently.

A successful password login clears cached data and reloads the server projection before selecting `/admin` or `/portal`. Signing out clears data and reloads `/login`. Magic links return to `/login` so the same server projection determines their destination; callback destinations never come from URL parameters.

Shell translations extend the catalog generated from `locales/loader.ts`. `createShellTranslator` accepts catalog overrides; missing keys retain the shared translator's visible-key fallback. Shell messages currently reside in `lib/shell.en.ts` within the shell's ownership boundary.

The admin shell (`admin-shell.tsx`) is mobile-first: a sticky one-line header with the gym name and an account menu (roles and sign-out), navigation in a menu on phones (focus moves into it; Escape, a press outside, or navigating closes it and Escape returns focus to the button) and a sticky sidebar from `md`, and the page gutters around `main`. Pages follow the UI conventions in [`../../README.md`](../../README.md).

Tailwind configuration and the design tokens are in `styles.css`, imported directly by `main.tsx` and processed by `@tailwindcss/vite`. Both dev and build use Vite with no generated CSS or installation scripts. Vite proxies `/api` to the local server. Set `SOURCE_URL` using the root environment configuration for development/builds.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web shell

The admin menu groups permitted links by task: Overview (Dashboard first), Gym,
Billing, Communication and Administration. Billing keeps invoices, plans and
reports together. Empty groups are hidden; the phone menu uses the same order.

`App` owns the Query client and Router providers. The default `ShellServices` loads and validates `/api/auth/bootstrap` using the shared contract: resolved gym, enabled modules, current session display name, optional nullable `staffProfileId`, roles/member access, and enabled password/magic-link methods. The profile ID belongs only to the signed-in user in the resolved gym; the bootstrap returns null when that login has no profile there. The schedule uses it to show an assigned coach the cancellation-notice option. It grants no authority. Pass `createShellServices(loadBootstrap)` to inject an alternative loader for tests. Navigation filtering is presentation only; the API enforces permissions independently.

A successful password login clears cached data and reloads the server projection before selecting `/admin` or `/portal`. Signing out clears data and reloads `/login`. Magic links return to `/login` so the same server projection determines their destination; callback destinations never come from URL parameters.

Google start failures keep the returned sign-in error visible. A successful start removes the `error` search parameter with replacement navigation, so a later identical error is shown again. Only the Google button stays disabled while the browser leaves; email and password sign-in remain usable if navigation stops. There is no timed fallback that could start a second OAuth request. Returning through the back-forward cache resets the Google button; reload to try Google again after stopped navigation.

Shell translations use `locales/en/shell/shell.json` in the catalog generated from `locales/loader.ts`. `createShellTranslator` accepts catalog overrides; missing keys retain the shared translator's visible-key fallback.

The admin shell (`admin-shell.tsx`) is mobile-first: a sticky two-line header with the gym name, then who is signed in (name and roles, the name truncating before the roles) and an account menu (**Your account**, which opens `/admin/account` from `features/account`, and sign-out), navigation in a menu on phones (focus moves into it; Escape, a press outside, or navigating closes it and Escape returns focus to the button) and a sticky sidebar from `md`, and the page gutters around `main`. Pages follow the UI conventions in [`../../README.md`](../../README.md).

Tailwind configuration and the design tokens are in `styles.css`, imported directly by `main.tsx` and processed by `@tailwindcss/vite`. Both dev and build use Vite with no generated CSS or installation scripts. Vite proxies `/api` to the local server. Set `SOURCE_URL` using the root environment configuration for development/builds.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Web shell

The admin menu groups permitted links by task: Overview (Dashboard first), Gym,
Billing, Communication and Administration. Billing keeps invoices, plans and
reports together. Empty groups are hidden; the phone menu uses the same order
without the group headings, sits below the header, demo row and update banner,
and locks the page's scroll while it is open.

`App` owns the Query client and Router providers. The default `ShellServices` loads and validates `/api/auth/bootstrap` using the shared contract: resolved gym, enabled modules, current session display name, optional nullable `staffProfileId`, roles/member access, and enabled password/magic-link methods. The profile ID belongs only to the signed-in user in the resolved gym; the bootstrap returns null when that login has no profile there. The schedule uses it to show an assigned coach the cancellation-notice option. It grants no authority. Pass `createShellServices(loadBootstrap)` to inject an alternative loader for tests. Navigation filtering is presentation only; the API enforces permissions independently.

A successful password login clears cached data and reloads the server projection before selecting `/admin` or `/portal`. Signing out clears data and reloads `/login`. Magic links return to `/login` so the same server projection determines their destination; callback destinations never come from URL parameters.

Google start failures keep the returned sign-in error visible. A successful start removes the `error` search parameter with replacement navigation, so a later identical error is shown again. Only the Google button stays disabled while the browser leaves; email and password sign-in remain usable if navigation stops. There is no timed fallback that could start a second OAuth request. Returning through the back-forward cache resets the Google button; reload to try Google again after stopped navigation.

Shell translations use `locales/en/shell/shell.json` in the catalog generated from `locales/loader.ts`. `createShellTranslator` accepts catalog overrides; missing keys retain the shared translator's visible-key fallback.

API refusal listeners are notified once at the response boundary: the typed
client's middleware and the JSON transport report structured HTTP 403 reasons;
custom fetch clients throw `await refusalError(response, code)` (or use
`readRefusal` for allowed messages and custom reasons), which reads the refused
body once and notifies at most once per response, whichever helpers read it.
`reportApiRefusal` is used only by the typed client's middleware in `lib/api.ts`; other clients use `refusalError` or `readRefusal`.
`ApiError` construction and `checked` only build or throw errors, and a source
check (`lib/api.sources.test.ts`) fails when a client outside `lib/api.ts` builds an `ApiError`
from a non-literal status or calls `reportApiRefusal` outside the listed callers.
Mapping an error does not open the demo copy prompt.

The mobile-first admin shell (`admin-shell.tsx`) has a sticky two-line header with the gym name, then who is signed in (name and roles, the name truncating before the roles). Navigation opens in a menu on phones and moves focus into it. The menu is as tall as its links, but stops 3rem short of the screen's bottom, so a strip of backdrop shows below it; it never gets shorter than one link, and it follows the header when content above the shell grows or shrinks. When one link wouldn't fit below the content above it, the menu moves up so that one shows, over the header's lower edge if need be. While it is open, the page behind it, the update banner, the demo rows (their error messages too), the skip link and the source footer are inert: `menu-covers.ts` does this for every element marked `data-menu-covers` on the page while the menu is open, one added after it opened too, and the portal's menu shares it. A tap or press on the banner or demo rows only closes the menu: a transparent layer under the header, down to the menu's top, takes it. Escape, a press outside, or navigating closes it. Escape returns focus to the button. The page's scroll padding keeps a control focused while scrolling up, or a section scrolled to, from hiding under the header, so a scroll target adds no margin for the header, only any gap of its own. Navigation sits in a sticky sidebar from `md`, and the shell supplies the page gutters around `main`. Pages follow the UI conventions in [`../../README.md`](../../README.md).

The admin and member portal share `account-menu.tsx`. In the admin, **Your account** opens `/admin/account` from `features/account`. The **Account** menu also provides sign-out and a **System**, **Light**, or **Dark** choice saved in the browser. The menu closes when **Sign out** is pressed. Until the request ends, a **Signing out…** status shows under the **Account** button while the menu is closed; presses pass through it to what is under it.

Tailwind configuration and the design tokens are in `styles.css`, imported directly by `main.tsx` and processed by `@tailwindcss/vite`. Both dev and build use Vite with no generated CSS or installation scripts. Vite proxies `/api` to the local server.

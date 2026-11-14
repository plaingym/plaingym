<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Website module

The optional public website: one theme, server-rendered with Hono JSX from the
gym's own data. A gym turns it on and off with `gyms.website_enabled` (Settings →
Gym details). The module registry checks that switch on every request, so while
it's off every route below answers 404. Core never imports this module.

## Pages

| Path | Shows |
| :--- | :--- |
| `/` | Home: the gym's name, tagline, calls to action (`/trial`, `/join`, `/portal`), the first photo, the about text, active programs, the other photos as a gallery and the address. |
| `/programs` | Each active program with the weekly classes linked to it. |
| `/schedule` | The weekly class templates by weekday, Monday first, as local wall times in the gym's timezone, then **Changes this week**: the week's (Monday to Sunday, in the gym's zone) sessions that differ from the timetable as it stands, by date: cancelled ones, one-off ones (no template, including those left by a deleted template) and moved ones (not at their template's weekday and time, including this week's occurrence moved into another week). A session that runs as the timetable says isn't listed. A coach is named only when their staff profile is public. |
| `/plans` | Active plans in the gym's currency, by name (the join page's order), with "+ tax" when an attached rate adds tax on top (the join page's rule), the sign-up fee, trial days and minimum term. |
| `/coaches` | Public staff profiles: name, rank, bio and photo. |
| `/contact` | Address with an OpenStreetMap search link, public phone (`tel:`) and email (`mailto:`). Missing fields tell gym owners where to set them in Settings. |

Every page links to the core public pages (`/trial`, `/drop-in`, `/join`), the
member portal and `/source`. With the website off, core's `GET /` handler
(`public/pages/pages.routes.ts`, `createRootRedirect`) sends `/` to `/portal`; it
is mounted first and hands the request on while the website is on.

Supporting routes: `/website/theme.css` (the primary and accent colors, validated
as `#rrggbb` before they reach CSS, with black or white text chosen for contrast;
the pages link it as `?v=<color content hash>`, and a request whose `v` matches is cached
as immutable, any other revalidates),
`/website/photos/{photoId}` and `/website/coaches/{staffProfileId}/photo` (streamed
from the gym's uploads; a coach photo only while the profile is public), and for
search engines `/sitemap.xml`, `/robots.txt`, canonical links, a description and
Open Graph tags on each page, and `LocalBusiness` JSON-LD on the home and contact
pages. The core public pages stay `noindex` and out of the sitemap.

The logo is core's `/public/pages/logo/{version}`. The pages address it by a short
hash of the logo's key, so the address changes with the file and survives settings
saves (the one search engines keep and an open page holds). Only the current key's
hash is accepted; a matching image is cached for one year as immutable. A page view
reads the `gyms` row once, for the gym and the module's settings together.
Public images (the logo, photos and coach photos)
share one helper, `serveGymImage`: the gym's own key, a PNG, JPEG or WebP, at most
2 MB, else 404.

## Security

* **CSP.** Each page sends its own policy: `default-src 'none'`, styles and images
  from the app's origin, no script except the structured-data block, which carries
  the response's nonce (`script-src 'nonce-…'`), no framing, and reports to
  `/csp-report`. Pages have no inline handlers or styles; the phone menu is a
  `<details>` disclosure, so nothing needs a script. The JSON-LD is serialized with
  `<`, `>` and `&` escaped, so gym text can't close the block.
* **Escaping.** Every gym-supplied string goes through the JSX renderer.
* **Isolation.** Every read runs in the request gym's `forGym` scope, so another
  gym's programs, plans, coaches and photos are invisible. Photos are found by ID
  in the gym's own settings and must sit under its `<gymId>/website/photos/` key
  prefix; coach photos under `<gymId>/staff/`.
* **Customization API** (`settings.manage`: owners and admins): `GET` and `PUT
  /api/website` (text, colors, photo order and descriptions; a photo left out is
  removed), `POST /api/website/photos`, `POST` and `DELETE /api/website/logo`. A
  staff session bound to another gym answers 404. Images are PNG, JPEG or WebP,
  checked by their bytes, at most 512 KiB (`areas/members/photos.ts`), and at most
  eight photos. Each upload is stored under a new key before the save, and marked
  deleted if the save fails; removed and replaced files are marked deleted after the
  save commits (only logos this module uploaded), for the uploads sweep. A storage
  error at that point is logged (`website.release_failed`) and the save still
  succeeds: the file simply waits for the sweep. The request and response schemas
  are `websiteContracts` in `@plaingym/shared/contracts`, shared with the admin.
  Settings responses include a nullable `logoVersion` (the short hash of its key);
  the admin preview and core public pages use that version too.

## Storage

The admin edits the brand color in Settings → Gym details. Website links there
and keeps any saved accent color when saving its text and photos; the admin has
one brand-color control. Logo uploads remain in the Website section.

The text, accent color and photo list live in the gym's settings under
`modules.website`, through `areas/settings/module-settings.ts`. Each save takes the
gym revision (a stale one answers 409) and writes a `settings.module.updated` audit
event. The logo key and primary color stay in `gyms.branding`, so the core public
pages use them too; the module saves them in the same revision. A stored value
that doesn't parse reads as empty. No schema file, migration or job.

## Composition

`configureWebsite({ uploadsFor, origin, clock })` gives the routes the gym's
uploads and its canonical origin (for canonical links, the sitemap and structured
data; without it they use the request's origin). Until it runs, the routes answer
503. The runtime adds `websiteModule` to its contributions' `modules`.

The pages share the core public stylesheet (`/public/pages/styles.css`), which
`public/links/styles.build.mjs` compiles from every `page.ts` and `*.page.ts`
under `public/` and `modules/`: write Tailwind classes in full in `site.page.ts`.
The admin's customization section is `apps/web/src/features/website/`, shown only
while the module is on. Strings are in `locales/en/website/` (`site.json` for the
pages, `website.json` for the admin).

`website.test.ts` runs the real area and module registrations against PostgreSQL:
the toggle (every route 404 when off, `/` redirects, the core pages and the portal
unaffected), each page and its policy, the API's permissions, and cross-gym
requests. `e2e/specs/website.spec.ts` checks the pages in a browser at 360 and
1280 px under the enforced CSP.

<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Product page screenshots

From the repository root, with pinned Node and pnpm, Docker running, and root and
`e2e` dependencies installed:

```sh
node e2e/ux-pass/product.mjs
```

Commit source changes first: the existing runner builds from `git archive HEAD`.
Install Chromium with `pnpm --dir e2e exec playwright install chromium` if needed.
Keep `E2E_LOOPBACK` when running beside other stacks. The command reuses the UX
pass's Compose install, sandbox fixture, seed, sign-ins, screen inventory and
settling helper. It runs only the product project and refuses CI execution.
`E2E_IMAGE` can reuse an image built from the source being captured.

`product.mjs` sets `CAPTURE_CLOCK_INSTANT` to the most recent Monday 12:00 UTC
at or before the run starts, so the sample week looks the same on every refresh.
The instant controls three things: the disposable demo container's JavaScript clock
(frozen by the capture overlay), each Playwright page's clock, and the waiver link's
expiry (one day later). It doesn't change PostgreSQL's `now()` or the browser's
cookie jar, which keep real time. The normal UX pass uses live time. The clock
shim is mounted, never included in the app image. No production clock or setting
changes.

`node --test e2e/ux-pass/product.test.mjs` checks the instant and the clock shim
without Docker.

The ten screens go to `apps/server/src/demo/screenshots/` as WebP at 1x and 2x,
in light and dark. Portal and waiver screens are 390×844, kiosk 768×900, and
admin/public join screens 1280×900. The Health overview is 1280×490, excluding
variable disk and version details below the first row. The admin, portal, kiosk,
public join page and signed waiver form follow the device theme in a fresh browser
context. The capture checks the applied color scheme before taking each screenshot.
`apps/server/src/demo/screenshots.json` records dimensions and content-hashed names.
If a dark WebP matches the light WebP byte for byte at the same density, both entries
point to the light file. The product page uses one source set when both densities
are shared. A complete run removes obsolete captures.
The root `README.md` uses the 2x images. Update its file names after a refresh and
include a dark source only where the 2x variants differ. `readme.docs.test.ts` checks
those references against the manifest. Review the images before committing:
only seeded people and data belong here, never tokens, QR credentials or device
registration screens. The waiver uses a new seeded signer; no bearer URL is pictured.
Each file must be under 200,000 bytes. Sizes also go in `e2e/coverage/product-capture.json`.
Billing uses the plan catalog: invoice sequence numbers can vary with concurrent
seed work. The ranks screen is scrolled to promotion readiness and progress.

The runner removes its stack with `down --volumes --remove-orphans` and removes its
unique capture image unless `E2E_IMAGE` supplied it. Cleanup has a two-minute timeout.
An interrupted process may need its `plaingym-e2e-<id>` resources removed manually;
never remove another run's resources.

For manual page review without Docker, install Chromium, Firefox and WebKit under
`e2e`, then run from the repository root:

```sh
pnpm --filter @plaingym/server exec tsx ../web/src/features/demo/product.browser-check.mjs
node apps/web/src/features/demo/landing.browser-check.mjs
```

The first checks the real renderer and committed assets in three browsers, both
themes and 360/1280-pixel viewports. The page's content security policy allows
only the current content-hashed phone menu script. The check disables JavaScript
in Chromium to exercise the native controls. Firefox's automation evaluation can
stall with that context setting. The check exercises every popover's image, close control, Esc, and
returned focus, plus outside click on desktop. It checks CSP and page overflow
and enforces the 300,000-byte initial HTML, CSS and JavaScript budget.
The second reviews the sandbox start page and menu with fixture discovery.
Images and JSON results go in `coverage/demo/product/` and `coverage/demo/browser/`.
Product review images come from Chromium and Firefox. WebKit runs every layout,
image and interaction check without exporting screenshots: Playwright's WebKit
screenshotter injects an inline `body {}` stylesheet even with caret hiding off,
which would create a tooling-only CSP violation. The page's policy is never relaxed.

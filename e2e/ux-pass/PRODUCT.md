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

The capture overlay freezes only the disposable demo container's JavaScript clock
at `2026-11-16T12:00:00Z`; Playwright fixes each page to that instant. The normal
UX pass uses live time. The clock shim is mounted, never included in the app image.
Update the instant in both `product-clock.mjs` and `product.spec.ts` deliberately
when refreshing the sample date. No production clock or setting changes.

The ten screens go to `apps/server/src/demo/screenshots/` as WebP at 1x and 2x,
in light and dark. Portal and waiver screens are 390×844, kiosk 768×900, and
admin/public join screens 1280×900. The Health overview is 1280×490, excluding
variable disk and version details below the first row. The admin, portal and kiosk follow the
device theme. A page without a theme class keeps its light palette.
`apps/server/src/demo/screenshots.json` records dimensions and content-hashed names.
A complete run removes obsolete captures. The root `README.md` shows the 1x captures
too: update its file names after a refresh (`readme.docs.test.ts` fails on a missing one). Review the images before committing:
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
themes and 360/1280-pixel viewports, under `script-src 'none'`. Chromium additionally
disables JavaScript in the context; Firefox's automation evaluation can stall with
that context setting. It exercises every
popover's image, close control, Esc, outside click and returned focus, checks CSP
and page overflow, and enforces the 300,000-byte initial HTML/CSS budget.
The second reviews the sandbox start page and menu with fixture discovery.
Images and JSON results go in `coverage/demo/product/` and `coverage/demo/browser/`.
Product review images come from Chromium and Firefox. WebKit runs every layout,
image and interaction check without exporting screenshots: Playwright's WebKit
screenshotter injects an inline `body {}` stylesheet even with caret hiding off,
which would create a tooling-only CSP violation. The page's policy is never relaxed.

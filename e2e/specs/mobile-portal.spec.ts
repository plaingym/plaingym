// SPDX-License-Identifier: AGPL-3.0-only
import { expect, demoClient, test } from '../support.js';
import { accessibleThemes } from '../responsive.js';
import { viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

for (const { name: size, viewport } of viewports) {
  test(`every portal page at ${size} width in light and dark`, async ({ page, context, sandboxes }, info) => {
    const sandbox = sandboxes[0]!, student = await demoClient(sandbox, 'student');
    await student.browser(context);
    await page.setViewportSize(viewport);
    for (const part of ['', '/schedule', '/checkin', '/progress', '/billing', '/waivers', '/household', '/account']) {
      await page.goto(sandbox.origin + '/portal' + part);
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0);
      await accessibleThemes(page, info, `${size}-portal${part.replace('/', '-') || '-home'}`);
    }
  });
}

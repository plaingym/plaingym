// SPDX-License-Identifier: AGPL-3.0-only
import { expect, demoClient, gymOrigin, test } from '../support.js';
import { check, viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

for (const { name: size, viewport } of viewports) {
  test(`every portal page at ${size} width in light and dark`, async ({ page, context, sandboxes }, info) => {
    const sandbox = sandboxes[0]!, student = await demoClient(sandbox, 'student');
    const owner = await demoClient(sandbox, 'owner');
    await page.setViewportSize(viewport);
    for (const path of ['/login', '/portal/claim']) {
      await page.goto(gymOrigin + path);
      await expect(page.locator('main h1')).toBeVisible();
      await check(page, info, `${size}${path.replaceAll('/', '-')}`);
    }

    const name = `Responsive ${size} participation waiver`;
    const waiver = (await owner.json<{ data: { id: string; version: number } }>('/api/waivers/templates', 'POST', {
      name, kind: 'waiver', body: 'Please tell an instructor about any injuries before training.',
    })).data;
    try {
      await student.browser(context);
      for (const part of ['', '/schedule', '/checkin', '/progress', '/billing', '/waivers', '/household', '/account']) {
        await page.goto(sandbox.origin + '/portal' + part);
        await expect(page.locator('main h1')).toBeVisible();
        await check(page, info, `${size}-portal${part.replace('/', '-') || '-home'}`);
        if (part === '/waivers') {
          await page.getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Review and sign', exact: true }).click();
          await expect(page.getByRole('dialog').locator('canvas')).toBeVisible();
          await check(page, info, `${size}-portal-waiver-signing`);
        }
      }
    } finally {
      await owner.json(`/api/waivers/templates/${waiver.id}/retire`, 'POST', { expectedVersion: waiver.version });
    }
    await context.clearCookies();
    await owner.browser(context);
    await page.goto(sandbox.origin + '/admin/outbox');
    await expect(page.locator('main h1')).toBeVisible();
    await expect(page.getByText(/sample text/i).first()).toBeVisible();
    // Message bodies may contain sign-in and signed links.
    await check(page, info, `${size}-demo-outbox`, [page.locator('main pre')]);
  });
}

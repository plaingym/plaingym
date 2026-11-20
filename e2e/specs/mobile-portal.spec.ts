// SPDX-License-Identifier: AGPL-3.0-only
import type { Page, TestInfo } from '@playwright/test';
import { expect, demoClient, gymOrigin, test } from '../support.js';
import { check, viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

const captureOutbox = (page: Page, info: TestInfo, name: string) => check(page, info, name, 'main pre');

test('outbox axe attachments omit message bodies even if a body would fail axe', async ({ page }, info) => {
  const body = 'Synthetic private message body';
  // An unnamed role="img" is an axe violation whose reported HTML includes this text.
  await page.setContent(`<!doctype html><html lang="en"><head><title>Outbox</title><style></style></head>
    <body><main><h1>Outbox</h1><pre role="img">${body}</pre></main></body></html>`);
  await expect(page.locator('main pre')).toHaveText(body);
  await captureOutbox(page, info, 'outbox-fixture');
  for (const scheme of ['light', 'dark']) {
    const attachment = info.attachments.find(({ name }) => name === `outbox-fixture-${scheme}-axe`);
    expect(attachment?.body?.toString()).toBe('[]');
  }
});

test('responsive capture waits for a Checking status to settle', async ({ page }, info) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Health</title></head>
    <body><main><h1>Health</h1><p role="status" data-loading>Checking...</p></main></body></html>`);
  await expect(page.getByRole('status')).toHaveText('Checking...');
  // The theme audit needs a stylesheet. Expose it only once the loaded screen is ready.
  await page.evaluate(() => {
    setTimeout(() => {
      document.head.append(document.createElement('style'));
      document.querySelector('[data-loading]')?.remove();
    }, 1000);
  });
  await check(page, info, 'checking-fixture');
  await expect(page.getByRole('status')).toHaveCount(0);
});

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
    await captureOutbox(page, info, `${size}-demo-outbox`);
  });
}

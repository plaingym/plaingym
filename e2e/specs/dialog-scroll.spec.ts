// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import { test, expect, createClass, demoClient, gymTimezone, showWeek, type Sandbox } from '../support.js';
import { sizes } from '../responsive.js';

// Cookies are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });

/** The dialog never scrolls itself, and once the body holds more than fits, only the body scrolls. */
async function onlyBodyScrolls(page: Page, dialog: Locator, surface: string) {
  // Pad the last child of the scrolling body so the content always overflows, whatever the seed data holds.
  await dialog.evaluate((element) => {
    const body = element.querySelector('[data-dialog-body]')!;
    const filler = document.createElement('div');
    filler.setAttribute('data-filler', '');
    filler.style.height = '3000px';
    body.append(filler);
  });
  const measure = await dialog.evaluate((element) => {
    const body = element.querySelector('[data-filler]')!.parentElement!;
    const heading = element.querySelector('h2')!.getBoundingClientRect();
    return { dialog: { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, scrollTop: element.scrollTop },
      body: { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight },
      headingTop: heading.top, dialogTop: element.getBoundingClientRect().top,
      lowest: [...element.querySelectorAll('*')].filter(e => !body.contains(e) && e !== body)
        .map(e => ({ n: e.tagName + '.' + String(e.className).slice(0, 60), b: Math.round(e.getBoundingClientRect().bottom) })).sort((a, b) => b.b - a.b).slice(0, 3),
      dialogBottom: Math.round(element.getBoundingClientRect().bottom), bodyBottom: Math.round(body.getBoundingClientRect().bottom) };
  });
  expect(measure.dialog.scrollHeight, surface + ': the dialog element does not scroll ' + JSON.stringify(measure)).toBeLessThanOrEqual(measure.dialog.clientHeight);
  expect(measure.body.scrollHeight, surface + ': the body scrolls').toBeGreaterThan(measure.body.clientHeight);
  // Scrolling the body leaves the header where it was.
  await dialog.evaluate((element) => { element.querySelector('[data-filler]')!.parentElement!.scrollTop = 500; });
  const after = await dialog.evaluate((element) => ({ scrollTop: element.scrollTop, headingTop: element.querySelector('h2')!.getBoundingClientRect().top }));
  expect(after.scrollTop, surface + ': the dialog stays at the top').toBe(0);
  expect(after.headingTop, surface + ': the header stays put').toBe(measure.headingTop);
  const box = (await dialog.boundingBox())!;
  expect(box.height, surface + ': the dialog fits the viewport').toBeLessThanOrEqual(page.viewportSize()!.height);
}

for (const size of sizes) {
  test(`long dialogs scroll only their body at ${size.width}x${size.height}`, async ({ page, sandboxes }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    const sandbox: Sandbox = sandboxes[1]!, owner = await demoClient(sandbox, 'owner');
    const name = 'Scroll ' + randomBytes(3).toString('hex'), session = await createClass(owner, name);
    const zone = await gymTimezone(owner);
    await owner.browser(page.context());

    await page.goto(sandbox.origin + '/admin/schedule');
    await showWeek(page, zone, Date.parse(session.startsAt));
    await page.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
    const sessionDialog = page.getByRole('dialog', { name });
    await expect(sessionDialog).toBeVisible();
    await onlyBodyScrolls(page, sessionDialog, 'session dialog');
    await page.keyboard.press('Escape');
    await expect(sessionDialog).toBeHidden();

    await page.goto(sandbox.origin + '/admin/campaigns');
    await page.getByRole('button', { name: 'New campaign', exact: true }).click();
    const campaignDialog = page.getByRole('dialog', { name: 'New campaign' });
    await expect(campaignDialog).toBeVisible();
    await onlyBodyScrolls(page, campaignDialog, 'campaign editor');
  });
}

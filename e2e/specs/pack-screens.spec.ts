// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';
import type { Page, TestInfo } from '@playwright/test';

async function check(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('[role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll('#main-content :is(button, select, input:not([type=checkbox]):not([type=hidden])), dialog[open] :is(button, select, input:not([type=checkbox]), textarea)')]
      .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || (element.matches('button, select') && box.width < 44)); })
      .map(element => element.getAttribute('name') || element.textContent) }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width); expect(sizes.small).toEqual([]);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map(row => row.id)).toEqual([]);
  await mkdir('coverage/packs', { recursive: true });
  const dialog = page.getByRole('dialog');
  const screenshot = await (await dialog.count() ? dialog.screenshot() : name.startsWith('member-')
    ? page.getByRole('tabpanel', { name: 'Packs', exact: true }).screenshot() : page.screenshot({ fullPage: true }));
  await writeFile('coverage/packs/' + name + '.png', screenshot);
  await info.attach(name, { body: screenshot, contentType: 'image/png' });
}

for (const width of [360, 1280]) {
  test(`class pack catalog, sale, invoice and adjustment at ${width}px`, async ({ browser, install }, info) => {
    test.setTimeout(180_000);
    const owner = install.clients.owner;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: `Packs ${width} family` })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Pack', lastName: String(width), status: 'active' })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 360, ignoreHTTPSErrors: true });
    await owner.browser(context); const page = await context.newPage();
    try {
      await page.goto(gymOrigin + '/admin/billing/plans');
      await page.getByRole('button', { name: 'Create class pack' }).click();
      const name = 'Class pack ' + width + ' ' + 'Q'.repeat(56);
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Price (' + settings.currency + ')').fill('12');
      await page.getByLabel('Credits', { exact: true }).fill('10');
      await page.getByLabel('Expiry days (optional)').fill('90');
      await check(page, info, 'editor-' + width);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await check(page, info, 'catalog-' + width);
      await page.goto(gymOrigin + '/admin/members/' + member.id + '#memberTabs.packs');
      await expect(page.getByText('Available credits: 0')).toBeVisible();
      await page.getByRole('button', { name: 'Sell a pack', exact: true }).click();
      const packs = (await owner.json<{ data: (RecordId & { name: string })[] }>('/api/billing/class-packs?limit=100')).data;
      await page.getByLabel('Class pack', { exact: true }).selectOption(packs.find(pack => pack.name === name)!.id);
      await check(page, info, 'sale-' + width);
      await page.getByRole('dialog').getByRole('button', { name: 'Sell a pack', exact: true }).click();
      const invoice = page.getByRole('dialog', { name: 'Invoice', exact: true });
      await expect(invoice.getByRole('button', { name: 'Record cash or check' })).toBeVisible();
      await check(page, info, 'invoice-' + width);
      await invoice.getByRole('button', { name: 'Record cash or check' }).click();
      await invoice.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(invoice.getByText('Paid', { exact: true }).first()).toBeVisible();
      await invoice.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByText('Available credits: 10')).toBeVisible();
      await page.getByRole('button', { name: 'Adjust credits', exact: true }).click();
      await page.getByLabel('Credit change').fill('-11'); await page.getByLabel('Reason', { exact: true }).fill('Desk correction');
      await page.getByRole('button', { name: 'Apply adjustment' }).click();
      await expect(page.getByRole('alert')).toContainText('not enough available credits');
      await check(page, info, 'adjustment-refusal-' + width);
      await page.getByLabel('Credit change').fill('-2'); await page.getByRole('button', { name: 'Apply adjustment' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByText('Available credits: 8')).toBeVisible();
      await expect(page.getByText('Desk correction')).toBeVisible();
      await check(page, info, 'member-' + width);
      await page.getByRole('button', { name: /^Invoice #/ }).first().click();
      await expect(page.getByRole('dialog', { name: 'Invoice', exact: true }).getByText('Paid', { exact: true }).first()).toBeVisible();
    } finally { await context.close(); }
  });
}

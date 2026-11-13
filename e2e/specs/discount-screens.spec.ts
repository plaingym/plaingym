// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';

async function check(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('[role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll('#main-content :is(button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden])), dialog[open] :is(button, select, input:not([type=checkbox]):not([type=radio]), textarea)')]
      .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || (element.matches('button, select') && box.width < 44)); })
      .map(element => element.getAttribute('name') || element.textContent) }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width); expect(sizes.small).toEqual([]);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map(row => row.id)).toEqual([]);
  await mkdir('coverage/discounts', { recursive: true });
  const dialog = page.getByRole('dialog');
  const screenshot = await (await dialog.count() ? dialog.screenshot() : name.startsWith('catalog-')
    ? page.getByRole('region', { name: 'Discounts', exact: true }).screenshot()
    : page.getByRole('tabpanel', { name: 'Memberships', exact: true }).screenshot());
  await writeFile('coverage/discounts/' + name + '.png', screenshot);
  await info.attach(name, { body: screenshot, contentType: 'image/png' });
}

for (const width of [360, 1280]) {
  test(`discount catalog, assignment, replacement, switch preview and removal at ${width}px`, async ({ browser, install }, info) => {
    test.setTimeout(180_000);
    const owner = install.clients.owner;
    const currency = (await owner.json<{ data: { currency: string } }>('/api/settings')).data.currency;
    const plan = (await owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name: 'Discount plan ' + width, currency, amountCents: 10000,
      interval: 'monthly', signupFeeCents: 1000, trialDays: 0, commitmentMonths: null, taxRateIds: [] })).data;
    const nextPlan = (await owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name: 'Discount next plan ' + width, currency, amountCents: 12000,
      interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, taxRateIds: [] })).data;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Discount family ' + width })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Discount', lastName: String(width), status: 'active' })).data;
    const name = 'Discount ' + width + ' ' + 'Q'.repeat(55), code = 'SCREEN-' + width;
    const replacement = (await owner.json<{ data: RecordId }>('/api/billing/discounts', 'POST', { name: 'Replacement ' + width, code: 'REPLACE-' + width,
      currency, percentBasisPoints: 1000, duration: 'once', planIds: [plan.id] })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 360, ignoreHTTPSErrors: true });
    await owner.browser(context); const page = await context.newPage();
    try {
      await page.goto(gymOrigin + '/admin/billing/plans');
      await page.getByRole('button', { name: 'Create discount', exact: true }).click();
      await page.getByLabel('Discount name').fill(name); await page.getByLabel('Discount code').fill(code);
      await page.getByLabel('Discount type').selectOption('percent'); await page.getByLabel('Percentage (up to 100)').fill('25');
      await page.getByRole('combobox', { name: /^Duration/ }).selectOption('cycles'); await page.getByLabel('Number of cycles').fill('3');
      await page.getByLabel('Also waive the signup fee').check(); await check(page, info, 'editor-' + width);
      await page.getByRole('button', { name: 'Save discount', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible(); await check(page, info, 'catalog-' + width);
      const discounts = (await owner.json<{ data: (RecordId & { name: string })[] }>('/api/billing/discounts?limit=100')).data;
      const discount = discounts.find(row => row.name === name)!;
      await page.goto(gymOrigin + '/admin/members/' + member.id + '#memberTabs.membership');
      const assignment = page.locator('form').filter({ has: page.getByRole('button', { name: 'Assign a plan', exact: true }) });
      await assignment.getByRole('combobox', { name: /^Plan/ }).selectOption(plan.id);
      await assignment.getByRole('combobox', { name: /^First period/ }).selectOption('next_billing_date');
      await assignment.getByRole('combobox', { name: /^Discount/ }).selectOption('named');
      await assignment.getByRole('combobox', { name: /^Choose a discount/ }).selectOption(discount.id); await check(page, info, 'assignment-' + width);
      await assignment.getByRole('button', { name: 'Assign a plan', exact: true }).click();
      await expect(page.getByText('Billing cycles left: 3', { exact: true })).toBeVisible(); await check(page, info, 'membership-' + width);
      await page.getByRole('button', { name: 'Change plan', exact: true }).click();
      let dialog = page.getByRole('dialog'); await dialog.getByRole('combobox', { name: /^New plan/ }).selectOption(nextPlan.id);
      await expect(dialog.getByText('The discount is kept on the new plan.', { exact: true })).toBeVisible(); await check(page, info, 'switch-kept-' + width);
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await page.getByRole('button', { name: 'Change discount', exact: true }).click();
      const change = page.locator('form').filter({ has: page.getByRole('button', { name: 'Apply discount', exact: true }) });
      await change.getByRole('combobox', { name: /^Discount/ }).selectOption('code'); await change.getByLabel('Discount code', { exact: true }).fill('replace-' + width);
      await check(page, info, 'replacement-' + width); await change.getByRole('button', { name: 'Apply discount', exact: true }).click();
      await expect(page.getByText('Discount: Replacement ' + width, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Change plan', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: /^New plan/ }).selectOption(nextPlan.id);
      await expect(dialog.getByText('The discount ends because it does not apply to the new plan.', { exact: true })).toBeVisible();
      await check(page, info, 'switch-ended-' + width); await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await page.getByRole('button', { name: 'Remove discount', exact: true }).click(); await check(page, info, 'removal-' + width);
      await page.getByRole('button', { name: 'Remove discount', exact: true }).click(); await expect(page.getByRole('button', { name: 'Add discount', exact: true })).toBeVisible();
      await page.goto(gymOrigin + '/admin/billing/plans'); await page.getByRole('button', { name: 'Edit Replacement ' + width, exact: true }).click();
      await expect(page.getByLabel('Discount type')).toBeDisabled(); await check(page, info, 'locked-' + width);
      await page.getByLabel('Active', { exact: true }).uncheck(); await page.getByRole('button', { name: 'Save discount', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const stored = (await owner.json<{ data: { active: boolean } }>('/api/billing/discounts/' + replacement.id)).data;
      expect(stored.active).toBe(false);
    } finally { await context.close(); }
  });
}

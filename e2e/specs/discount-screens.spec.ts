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
  const screenshot = await (await dialog.count() ? dialog.screenshot() : name.startsWith('household-')
    ? page.locator('form').filter({ has: page.getByRole('button', { name: 'Save billing settings', exact: true }) }).screenshot() : name.startsWith('catalog-')
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
    await owner.json('/api/billing/discounts', 'POST', { name: 'Waiver ' + width, code: 'WAIVER-' + width, currency, waivesSignupFee: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 360, ignoreHTTPSErrors: true });
    await owner.browser(context); const page = await context.newPage();
    try {
      await page.goto(gymOrigin + '/admin/billing/plans');
      await page.getByRole('button', { name: 'Create discount', exact: true }).click();
      await page.getByLabel('Discount name').fill(name); await page.getByLabel('Discount code').fill(code);
      await page.getByLabel('Discount type').selectOption('percent'); await page.getByLabel('Percentage (up to 100)').fill('25');
      await page.getByRole('combobox', { name: /^Duration/ }).selectOption('cycles'); await page.getByLabel('Number of cycles').fill('3');
      await page.getByLabel('Also waive the sign-up fee').check(); await check(page, info, 'editor-' + width);
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
      await expect(dialog.getByText(/The new price, .* applies when the membership is next billed as active, on or after/)).toBeVisible();
      await expect(dialog.getByText(/The new price, .* starts on/)).toHaveCount(0);
      await expect(dialog.getByText('The discount is kept on the new plan.', { exact: true })).toBeVisible(); await check(page, info, 'switch-kept-' + width);
      // Back is a guarded dismissal now: the edited plan choice asks before it is discarded.
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await expect(dialog.getByText('Discard your unsaved changes?')).toBeVisible();
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.route('**/switch/preview?*', route => route.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'conflict', message: 'Change unavailable', details: { reason: ['unknown_reason'] } } }) }));
      // Reopening within the app's cache window reuses the quote; reload so this assertion exercises a refused request.
      await page.reload();
      await page.getByRole('button', { name: 'Change plan', exact: true }).click();
      dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('alert')).toContainText('Could not check the change. Please try again.');
      await expect(dialog.getByRole('button', { name: 'Change plan', exact: true })).toBeDisabled();
      await check(page, info, 'switch-preview-refused-' + width);
      await page.unroute('**/switch/preview?*');
      await dialog.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(dialog.getByText('The discount is kept on the new plan.', { exact: true })).toBeVisible();
      // Retrying the preview edits no field, so this Back is an unedited dismissal and closes at once.
      await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Change discount', exact: true }).click();
      const change = page.locator('form').filter({ has: page.getByRole('button', { name: 'Apply discount', exact: true }) });
      await change.getByRole('combobox', { name: /^Discount/ }).selectOption('code'); await change.getByLabel('Discount code', { exact: true }).fill('WAIVER-' + width);
      await change.getByRole('button', { name: 'Apply discount', exact: true }).click();
      await expect(change.getByRole('alert')).toContainText('only waives the sign-up fee');
      await expect(change.getByRole('button', { name: 'Apply discount', exact: true })).toBeEnabled();
      await check(page, info, 'fee-only-refused-' + width);
      await change.getByLabel('Discount code', { exact: true }).fill('replace-' + width);
      await check(page, info, 'replacement-' + width); await change.getByRole('button', { name: 'Apply discount', exact: true }).click();
      await expect(page.getByText('Discount: Replacement ' + width, { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Change plan', exact: true }).click(); dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: /^New plan/ }).selectOption(nextPlan.id);
      await expect(dialog.getByText('The discount ends because it does not apply to the new plan.', { exact: true })).toBeVisible();
      await check(page, info, 'switch-ended-' + width); await dialog.getByRole('button', { name: 'Go back', exact: true }).click();
      await expect(dialog.getByText('Discard your unsaved changes?')).toBeVisible();
      await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Remove discount', exact: true }).click(); await check(page, info, 'removal-' + width);
      await page.getByRole('button', { name: 'Remove discount', exact: true }).click(); await expect(page.getByRole('button', { name: 'Add discount', exact: true })).toBeVisible();
      await page.goto(gymOrigin + '/admin/billing/plans'); await page.getByRole('button', { name: 'Edit Replacement ' + width, exact: true }).click();
      await expect(page.getByLabel('Discount type')).toBeDisabled(); await check(page, info, 'locked-' + width);
      await page.getByLabel('Discount name').fill(name); await page.getByRole('button', { name: 'Save discount', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('name or code already exists');
      await expect(page.getByRole('button', { name: 'Save discount', exact: true })).toBeEnabled();
      await check(page, info, 'duplicate-refused-' + width);
      await page.getByLabel('Discount name').fill('Replacement ' + width);
      await page.getByLabel('Active', { exact: true }).uncheck(); await page.getByRole('button', { name: 'Save discount', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      const stored = (await owner.json<{ data: { active: boolean } }>('/api/billing/discounts/' + replacement.id)).data;
      expect(stored.active).toBe(false);
      const tax = (await owner.json<{ data: RecordId }>('/api/billing/tax-rates', 'POST', { name: 'Conflict tax ' + width, rateMillionths: 50000, inclusive: false })).data;
      await page.reload(); await page.getByRole('button', { name: 'Add plan', exact: true }).click();
      const editor = page.getByRole('dialog');
      await editor.getByLabel('Name', { exact: true }).fill('Conflict plan ' + width);
      await editor.getByLabel(new RegExp('^Conflict tax ' + width)).check();
      await owner.json('/api/billing/tax-rates/' + tax.id, 'PATCH', { revision: 1, active: false });
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor.getByRole('alert')).toContainText('A selected tax rate is inactive');
      await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      await check(page, info, 'catalog-tax-refused-' + width);
      await editor.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page.goto(gymOrigin + '/admin/members/' + member.id);
      const family = page.getByLabel('Family discount (%)', { exact: true });
      await family.fill('1e1'); await page.getByRole('button', { name: 'Save billing settings', exact: true }).click();
      await expect(family).toHaveAttribute('aria-invalid', 'true'); await check(page, info, 'household-invalid-' + width);
      await family.fill('.5'); await page.getByRole('button', { name: 'Save billing settings', exact: true }).click();
      await expect(family).toHaveAttribute('aria-invalid', 'false');
      await check(page, info, 'household-decimal-' + width);
    } finally { await context.close(); }
  });
}

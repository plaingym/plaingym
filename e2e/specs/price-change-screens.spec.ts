// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { addDays, localDate } from '../dates.js';
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';

async function capture(page: Page, info: TestInfo, name: string) {
  const dialog = page.getByRole('dialog');
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
    small: [...document.querySelectorAll('dialog[open] button, dialog[open] input:not([type=checkbox]):not([type=radio]), dialog[open] select')]
      .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height < 44; }).map(element => element.textContent) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width); expect(dimensions.small).toEqual([]);
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(axe.violations.map(row => row.id)).toEqual([]);
  await mkdir('coverage/price-changes', { recursive: true });
  const body = await dialog.screenshot();
  await writeFile('coverage/price-changes/' + name + '.png', body);
  await info.attach(name, { body, contentType: 'image/png' });
}

for (const width of [360, 1280]) test('plan price selection, summary, warning and result at ' + width + 'px', async ({ browser, install }, info) => {
  test.setTimeout(150_000);
  const owner = install.clients.owner;
  const settings = (await owner.json<{ data: { currency: string; timezone: string } }>('/api/settings')).data;
  const today = localDate(new Date(), settings.timezone), name = 'Price screen ' + width;
  const plan = (await owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name, currency: settings.currency, amountCents: 10000,
    interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, taxRateIds: [] })).data;
  const membershipIds: string[] = [];
  for (const suppressed of [false, true]) {
    const email = suppressed ? 'price-payer-' + width + '@example.test' : null;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Price family ' + width, email })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: suppressed ? 'Suppressed' : 'Ordinary',
      lastName: String(width), status: 'active', email, emailOptOut: suppressed })).data;
    const membership = (await owner.json<{ data: RecordId }>('/api/billing/memberships', 'POST', { householdId: home.id, memberId: member.id,
      planId: plan.id, startsOn: today, nextDueOn: today, firstPeriod: 'next_billing_date' })).data;
    membershipIds.push(membership.id);
  }
  const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 360, ignoreHTTPSErrors: true });
  await owner.browser(context); const page = await context.newPage();
  try {
    await page.goto(gymOrigin + '/admin/billing/plans');
    await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
    await page.getByLabel('Amount (' + settings.currency + ')').fill('120.00');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Change plan price' })).toBeVisible();
    await capture(page, info, 'choice-' + width);
    await dialog.getByRole('radio', { name: 'Choose members', exact: true }).check();
    await expect(dialog.getByLabel('Effective from')).toHaveValue(addDays(today, 30));
    await expect(dialog.getByRole('checkbox', { name: 'Move Ordinary ' + width, exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Move Suppressed ' + width, exact: true })).toBeChecked();
    await capture(page, info, 'selection-' + width);
    await dialog.getByLabel('Search by member name').fill('Suppressed');
    await expect(dialog.getByRole('checkbox', { name: 'Move Ordinary ' + width, exact: true })).toHaveCount(0);
    await dialog.getByLabel('Search by member name').fill('');
    await dialog.getByRole('radio', { name: 'All existing members', exact: true }).check();
    await capture(page, info, 'all-' + width);
    await dialog.getByLabel('Effective from').fill(today);
    await dialog.getByRole('button', { name: 'Update preview for this date' }).click();
    await expect(dialog.getByRole('button', { name: 'Review change' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Review change' }).click();
    await expect(dialog.getByText('Memberships scheduled: 2, from ' + today + '.', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Households not emailed because the payer opted out of email or the address is undeliverable: 1. Tell them another way.', { exact: true })).toBeVisible();
    await capture(page, info, 'summary-warning-' + width);
    await dialog.getByLabel('I confirm applying this increase with short notice or without email notice.').check();
    await dialog.getByRole('button', { name: 'Apply price change', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: 'Price change result' })).toBeVisible();
    await expect(dialog.getByText('Memberships scheduled: 2, from ' + today + '.', { exact: true })).toBeVisible();
    await capture(page, info, 'result-' + width);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const preview = (await owner.json<{ data: { memberships: (RecordId & { scheduled: { amountCents: number } | null })[] } }>(
      '/api/billing/plans/' + plan.id + '/price-change?amountCents=12000&effectiveOn=' + today)).data;
    for (const id of membershipIds) expect(preview.memberships.find(row => row.id === id)?.scheduled?.amountCents).toBe(12000);
    await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
    await page.getByLabel('Amount (' + settings.currency + ')').fill('130.00');
    await page.getByLabel('Billing interval').selectOption('annual');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('radio')).toHaveCount(1);
    await expect(dialog.getByRole('note')).toContainText('Changing the billing interval or currency applies only to new members');
    await capture(page, info, 'terms-new-only-' + width);
    await dialog.getByRole('button', { name: 'Review change' }).click();
    await capture(page, info, 'terms-summary-' + width);
    await dialog.getByRole('button', { name: 'Apply price change', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const updated = (await owner.json<{ data: { amountCents: number; interval: string } }>('/api/billing/plans/' + plan.id)).data;
    expect(updated).toMatchObject({ amountCents: 13000, interval: 'annual' });
    const afterTerms = (await owner.json<{ data: { memberships: { id: string; scheduled: { amountCents: number; interval: string } | null }[] } }>(
      '/api/billing/plans/' + plan.id + '/price-change?amountCents=13000&effectiveOn=' + today)).data;
    for (const id of membershipIds) expect(afterTerms.memberships.find(row => row.id === id)?.scheduled).toMatchObject({ amountCents: 12000, interval: 'monthly' });
  } finally { await context.close(); }
});

// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin, type Person, type RecordId } from '../support.js';
import { localDate } from '../dates.js';
import { horizontalOverflow } from '../responsive.js';

const dateLabel = (date: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T00:00:00Z'));
for (const width of [360, 1280]) {
  test(`freeze warning and persistent history at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const settings = (await owner.json<{ data: { currency: string; timezone: string } }>('/api/settings')).data;
    const today = localDate(new Date(), settings.timezone);
    const plan = (await owner.json<{ data: RecordId }>('/api/billing/plans', 'POST', { name: 'Freeze history ' + width,
      currency: settings.currency, amountCents: 10000, interval: 'monthly', signupFeeCents: 0, trialDays: 14,
      commitmentMonths: null, taxRateIds: [] })).data;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Freeze family ' + width })).data;
    const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id,
      firstName: 'Freeze', lastName: String(width), status: 'trial' })).data;
    const membership = (await owner.json<{ data: RecordId & { nextDueOn: string } }>('/api/billing/memberships', 'POST', {
      householdId: home.id, memberId: member.id, planId: plan.id, startsOn: today, nextDueOn: today, firstPeriod: 'next_billing_date' })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 360, ignoreHTTPSErrors: true });
    await owner.browser(context);
    const page = await context.newPage();
    try {
      await page.goto(gymOrigin + '/admin/members/' + member.id + '#memberTabs.membership');
      await page.getByRole('button', { name: 'Freeze', exact: true }).click();
      await expect(page.getByText('Freezing skips the billing date ' + dateLabel(membership.nextDueOn), { exact: false })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeUndefined();
      await mkdir('coverage/freezes', { recursive: true });
      const panel = page.getByRole('tabpanel', { name: 'Memberships', exact: true });
      await writeFile('coverage/freezes/warning-' + width + '.png', await panel.screenshot());
      await panel.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText('Membership saved.', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await panel.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Freeze', exact: true })).toBeVisible();
      // Reload to prove this comes from the saved audit, after the resume cleared frozenAt.
      await page.reload();
      await page.getByRole('button', { name: 'Freeze history', exact: true }).click();
      const history = page.getByRole('region', { name: 'Freeze history', exact: true });
      await expect(history.getByText('Skipped billing date: ' + dateLabel(membership.nextDueOn), { exact: true })).toBeVisible();
      await expect(history.getByText('Next billing date after this freeze:', { exact: false })).toBeVisible();
      // A new freeze refreshes an already-open panel without a reload, on phone and desktop.
      await page.getByRole('button', { name: 'Freeze', exact: true }).click();
      await panel.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(history.locator('li')).toHaveCount(2);
      await expect(history.getByText('Skipped billing date: ' + dateLabel(membership.nextDueOn), { exact: true })).toBeVisible();
      expect(await horizontalOverflow(page)).toBeUndefined();
      const small = await history.locator('button').evaluateAll(elements => elements.filter(element => {
        const box = element.getBoundingClientRect(); return box.width < 44 || box.height < 44;
      }).length);
      expect(small).toBe(0);
      const screenshot = await panel.screenshot();
      await writeFile('coverage/freezes/history-' + width + '.png', screenshot);
      await info.attach('freeze-history-' + width, { body: screenshot, contentType: 'image/png' });
    } finally { await context.close(); }
  });
}

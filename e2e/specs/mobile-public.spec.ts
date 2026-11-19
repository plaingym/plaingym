// SPDX-License-Identifier: AGPL-3.0-only
import { expect, demoClient, test, localDate, type RecordId } from '../support.js';
import { accessibleThemes } from '../responsive.js';
import { outboxIds, outboxLink } from '../portal.js';
import { viewports } from './mobile-screens.js';

// Device and signed-link credentials stay out of traces.
test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

for (const { name: size, viewport } of viewports) {
  test(`signed links and core public pages at ${size} width in light and dark`, async ({ page, sandboxes }, info) => {
    const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
    const household = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Accessibility ' + size })).data;
    const member = (await owner.json<{ data: RecordId }>('/api/members', 'POST', { householdId: household.id,
      firstName: 'Accessibility', lastName: size, dateOfBirth: '1990-01-01' })).data;
    const invoice = (await owner.json<{ data: RecordId }>('/api/billing/invoices/one-off', 'POST', { householdId: household.id,
      dueOn: localDate(new Date(), 'UTC'), source: 'custom', description: 'Accessibility review', currency: 'USD', amountCents: 1000, taxRateIds: [] })).data;
    await page.setViewportSize(viewport);
    const check = (name: string) => accessibleThemes(page, info, size + '-' + name, {
      async checkPalette(scheme) {
        await expect(page.locator('html')).toHaveClass('theme-system');
        await expect(page.locator('body')).toHaveCSS('background-color', scheme === 'dark' ? 'rgb(12, 21, 20)' : 'rgb(255, 255, 255)');
      },
    });
    for (const [purpose, extra] of [['pay_invoice', { invoiceId: invoice.id }], ['update_card', {}], ['onboarding', {}], ['sign_waiver', { memberId: member.id }]] as const) {
      const link = (await owner.json<{ data: { link: RecordId; token: string } }>('/api/links', 'POST', {
        purpose, householdId: household.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra,
      })).data;
      await page.goto(sandbox.origin + '/l/' + link.token);
      await expect(page.locator('main h1')).toBeVisible();
      await check('link-' + purpose);
      await owner.json('/api/links/' + link.link.id + '/revoke', 'POST', {});
    }
    await page.reload();
    await expect(page.getByRole('heading', { name: 'This link is unavailable', exact: true })).toBeVisible();
    await check('link-unavailable');
    for (const path of ['/join', '/trial', '/drop-in']) {
      await page.goto(sandbox.origin + path);
      await expect(page.locator('main h1')).toBeVisible();
      await check(path.slice(1));
      if (path === '/join') {
        await page.locator('a[href^="/join?plan="]').first().click();
        await expect(page.locator('form[data-join-form]')).toBeVisible();
        await check('join-form');
      }
    }
    // Unsubscribe links are issued only by an announcement, never by the staff link endpoint.
    const initial = (await owner.json<{ data: RecordId & { memberEmailsEnabled: boolean } }>('/api/settings/go-live')).data;
    try {
      if (!initial.memberEmailsEnabled) await owner.json('/api/settings/go-live', 'PATCH', { revision: initial.revision, memberEmailsEnabled: true });
      const people = (await owner.json<{ data: (RecordId & { status: string; email: string | null })[] }>('/api/members?limit=100')).data;
      const recipient = people.find(person => person.status === 'active' && person.email)!;
      const before = await outboxIds(owner);
      await owner.json('/api/announcements/send', 'POST', { subject: 'Accessibility review ' + size, body: 'Class notice.', sendGeneration: crypto.randomUUID(), confirm: true });
      const unsubscribe = await outboxLink(owner, recipient.email!, /^\/l\//, before);
      await page.goto(unsubscribe.href);
      await expect(page.getByRole('button', { name: 'Unsubscribe', exact: true })).toBeVisible();
      await check('link-unsubscribe');
    } finally {
      if (!initial.memberEmailsEnabled) {
        const current = (await owner.json<{ data: RecordId }>('/api/settings/go-live')).data;
        await owner.json('/api/settings/go-live', 'PATCH', { revision: current.revision, memberEmailsEnabled: false });
      }
    }
    await page.goto(sandbox.origin + '/staff-invitation');
    await expect(page.locator('main h1')).toBeVisible();
    await check('staff-invitation');

    // The email confirmation uses native browser styling.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(sandbox.origin + '/account-email');
      await expect(page.locator('main h1')).toBeVisible();
      await expect(page.locator('html')).toHaveClass('theme-system');
      await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', 'light dark');
      await info.attach(size + '-account-email-' + colorScheme, { body: await page.screenshot(), contentType: 'image/png' });
    }
    const document = await page.goto(sandbox.origin + '/api/public/waivers/' + crypto.randomUUID() + '/document?view=1');
    expect(document?.status()).toBe(404);
    expect(await page.locator('html').getAttribute('class')).toBeNull();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  });
}

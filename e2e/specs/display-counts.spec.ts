// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

test.use({ locale: 'de-DE' });
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const householdId = id(3), memberId = id(4), sessionId = id(5), invoiceId = id(6);
for (const width of [360, 1280]) {
  test(`keeps portal counts English in a German browser at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const today = '2026-11-11T12:00:00Z', startsAt = '2026-11-12T12:00:00Z';
    await page.clock.setFixedTime(new Date(today));
    const invoice = { id: invoiceId, number: 1200, kind: 'one_off', status: 'paid', dueOn: '2026-11-01', amountCents: 2500,
      currency: 'USD', paidAt: '2026-11-01T12:00:00Z' };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const answer = (data: unknown, pagination?: object) => route.fulfill({ json: { householdId, data, ...(pagination ? { pagination } : {}) } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: id(1), name: 'North Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId: id(2), displayName: 'Alex Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera', role: 'payer' }] } } });
      if (path === '/api/portal/context') return answer({ role: 'payer', memberId });
      if (path === '/api/portal/schedule/members') return answer([{ id: memberId, name: 'Alex Rivera' }]);
      if (path === '/api/portal/schedule') return answer([{
        id: sessionId, name: 'Evening fundamentals', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(),
        coachId: null, capacity: 5000, status: 'scheduled', revision: 1, bookingOpensAt: today,
        cancelBefore: startsAt, placesLeft: 1200, bookings: [{ id: id(9), memberId, sessionId, createdAt: new Date().toISOString(),
          status: 'waitlisted', waitlistPosition: 2400, queueRank: 2400, cancelledAt: null }],
      }], { limit: 100, offset: 0, total: 1 });
      if (path === '/api/portal/credits') return answer([{ memberId, firstName: 'Alex', lastName: 'Rivera', balance: 3600, soonestExpiry: null }]);
      if (path.endsWith('/waivers/pending')) return answer([], { limit: 1, offset: 0, total: 4800 });
      if (path === '/api/portal/invoices') return answer([invoice], { limit: 20, offset: 0, total: 1 });
      if (path === '/api/portal/invoices/' + invoiceId) return answer({ invoice, lines: [{ id: id(10), kind: 'charge', description: 'Mat fee', amountCents: 2500,
        currency: 'USD', quantity: 5600, taxRateMillionths: null, taxInclusive: null }] });
      if (path === '/api/portal/payment-methods') return answer([{ id: id(11), type: 'card', bankName: null, brand: 'visa', last4: '1200', expiryMonth: 4, expiryYear: 2029, isDefault: true }]);
      if (path.endsWith('/progress')) return answer({ history: [], programs: [], ranks: [], criteria: [] });
      if (path.endsWith('/attendance')) return answer([{ id: id(12), memberId, sessionId, sessionName: 'Evening fundamentals', programId: null,
        occurredAt: startsAt, source: 'kiosk', kind: 'class' }], { limit: 20, offset: 0, total: 6800 });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    for (const path of ['', '/schedule', '/billing', '/progress']) {
      await page.goto(gymOrigin + '/portal' + path);
      if (path === '') await expect(page.getByText('Unsigned waivers: 4,800')).toBeVisible();
      if (path === '/schedule') {
        const card = page.getByRole('button', { name: /^Evening fundamentals, / });
        await expect(card).toHaveAccessibleName(/Waitlist — position 2,400$/);
        await card.click();
        const dialog = page.getByRole('dialog', { name: 'Evening fundamentals' });
        await expect(dialog.getByText('Places left: 1,200')).toBeVisible();
        await expect(dialog.getByText('Waitlist — position 2,400')).toBeVisible();
      }
      if (path === '/billing') {
        await expect(page.getByText('3,600 classes left')).toBeVisible();
        await expect(page.getByText('Invoice #1200')).toBeVisible();
        await expect(page.getByText(/1200/).filter({ hasText: '••••' })).toBeVisible();
        await page.getByRole('button', { name: 'Details', exact: true }).click();
        await expect(page.getByText(/Quantity 5,600/)).toBeVisible();
        await expect(page.getByText('$25.00', { exact: true }).first()).toBeVisible();
      }
      if (path === '/progress') await expect(page.getByText('Visits: 6,800')).toBeVisible();
      await accessibleLayout(page, info, 'display-counts-' + (path.slice(1) || 'home') + '-' + width);
      await info.attach('display-counts-' + (path.slice(1) || 'home') + '-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    }
  });
}

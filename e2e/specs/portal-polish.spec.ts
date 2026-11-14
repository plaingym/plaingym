// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const householdId = id(3), memberId = id(4);
for (const width of [360, 1280]) {
  test(`portal pages use one content width and clear states at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const startsAt = new Date().toISOString();
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const answer = (data: unknown, pagination?: object) => route.fulfill({ json: { householdId, data, ...(pagination ? { pagination } : {}) } });
      const list = (data: unknown[]) => answer(data, { limit: 100, offset: 0, total: data.length });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: id(1), name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId: id(2), displayName: 'Pat Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera household', role: 'payer' }] } } });
      if (path === '/api/portal/context') return answer({ role: 'payer', memberId });
      if (path === '/api/portal/schedule/members') return answer([{ id: memberId, name: 'Pat Rivera' }]);
      if (path === '/api/portal/schedule') return list([{
        id: id(5), name: 'Evening class', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(),
        coachId: null, capacity: 10, status: 'cancelled', revision: 1, bookingOpensAt: new Date().toISOString(),
        cancelBefore: startsAt, placesLeft: 10, bookings: [],
      }]);
      if (path === '/api/portal/household') return answer({ id: householdId, name: 'Rivera household', email: null, phone: null, address: {}, billingDay: 1, revision: 1 });
      if (path === '/api/portal/members') return list([{ id: memberId, firstName: 'Pat', lastName: 'Rivera', email: null, phone: null,
        dateOfBirth: '1980-04-02', photoKey: null, status: 'active', emergencyContacts: [], revision: 1 }]);
      if (path.endsWith('/progress')) return answer({ history: [], programs: [], ranks: [], criteria: [] });
      if (path.endsWith('/checkin-code')) return answer({ memberId, code: null, version: 1, revision: 1 });
      if (path === '/api/portal/credits' || path === '/api/portal/payment-methods') return answer([]);
      if (path.endsWith('/waivers') || path.endsWith('/waivers/pending') || path.endsWith('/attendance') || path === '/api/portal/invoices') return list([]);
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    let contentWidth: number | undefined;
    for (const path of ['', '/schedule', '/household', '/billing', '/waivers', '/progress', '/checkin']) {
      await page.goto(gymOrigin + '/portal' + path);
      const content = page.locator('main .max-w-3xl');
      await expect(content.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(content.getByText(/Loading/)).toHaveCount(0);
      await expect(content.getByRole('alert')).toHaveCount(0);
      const measured = (await content.boundingBox())!.width;
      contentWidth ??= measured;
      expect(measured).toBe(contentWidth);
      if (path === '/schedule') await expect(content.getByText('Cancelled', { exact: true })).toHaveCount(1);
      if (path === '/waivers') await expect(content.getByText('Everything is signed')).toBeVisible();
      await accessibleLayout(page, info, 'portal-polish-' + (path.slice(1) || 'home'));
      await info.attach(`portal-${path.slice(1) || 'home'}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    }
  });
}

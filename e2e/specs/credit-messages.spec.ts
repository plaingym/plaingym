// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const householdId = id(3), memberId = id(4);
const refusal = 'You need an unexpired class credit or an active or trial membership to book or join the waitlist. Please contact the front desk.';

for (const width of [360, 1280]) {
  test(`portal credit expiry and booking refusal at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const startsAt = new Date(Date.now() + 86400_000).toISOString();
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const answer = (data: unknown, pagination?: object) => route.fulfill({ json: { householdId, data, ...(pagination ? { pagination } : {}) } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: id(1), name: 'Test Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] },
        session: { userId: id(2), displayName: 'Alex Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera household', role: 'member' }] } } });
      if (path === '/api/portal/context') return answer({ role: 'member', memberId });
      if (path === '/api/portal/credits') return answer([{ memberId, firstName: 'Alex', lastName: 'Rivera', balance: 8, soonestExpiry: '2026-11-12T08:00:00Z' }]);
      if (path === '/api/portal/schedule/members') return answer([{ id: memberId, name: 'Alex Rivera' }]);
      if (path === '/api/portal/schedule') return answer([{
        id: id(5), name: 'Fundamentals', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(),
        coachId: null, capacity: 10, status: 'scheduled', revision: 1, bookingOpensAt: new Date(Date.now() - 86400_000).toISOString(),
        cancelBefore: startsAt, placesLeft: 4, bookings: [],
      }], { limit: 100, offset: 0, total: 1 });
      if (path === '/api/portal/bookings') return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: refusal, details: { reason: ['noCredits'] } } } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/portal/billing');
    await expect(page.getByText('8 classes left')).toBeVisible();
    const lastDay = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'America/Los_Angeles' }).format(new Date('2026-11-12T07:59:59.999Z'));
    await expect(page.getByText('Next credits expire: use by ' + lastDay)).toBeVisible();
    await accessibleLayout(page, info, 'credit-expiry');
    await info.attach('credit-expiry-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.goto(gymOrigin + '/portal/schedule');
    await page.getByRole('button', { name: 'Book Fundamentals for Alex Rivera', exact: true }).click();
    await expect(page.getByText(refusal)).toBeVisible();
    await accessibleLayout(page, info, 'credit-refusal');
    await info.attach('credit-refusal-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
}

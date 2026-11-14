// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const householdId = id(3), memberId = id(4), sessionId = id(5), programId = id(6), firstRank = id(7), nextRank = id(8);
for (const width of [360, 1280]) {
  test(`portal home summaries and named attendance at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let role: 'payer' | 'member' = 'payer', invoiceReads = 0;
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      const answer = (data: unknown, pagination?: object) => route.fulfill({ json: { householdId, data, ...(pagination ? { pagination } : {}) } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: id(1), name: 'North Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId: id(2), displayName: 'Alex Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera household', role }] } } });
      if (path === '/api/portal/context') return answer({ role, memberId });
      if (path === '/api/portal/schedule/members') return answer([{ id: memberId, name: 'Alex Rivera' }]);
      if (path === '/api/portal/schedule') return answer([{
        id: sessionId, name: 'Evening fundamentals', startsAt, endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(),
        coachId: null, capacity: 10, status: 'scheduled', revision: 1, bookingOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
        cancelBefore: startsAt, placesLeft: 4, bookings: [{ id: id(9), memberId, sessionId, createdAt: new Date().toISOString(),
          status: 'booked', waitlistPosition: null, queueRank: null, cancelledAt: null }],
      }], { limit: 100, offset: 0, total: 1 });
      if (path.endsWith('/waivers/pending')) return answer([], { limit: 1, offset: 0, total: 2 });
      if (path === '/api/portal/invoices') { invoiceReads++; return answer([], { limit: 1, offset: 0, total: 1 }); }
      if (path.endsWith('/progress')) return answer({ history: [],
        programs: [{ id: programId, name: 'Grappling', current: { rankId: firstRank, subRank: 0 }, next: { rankId: nextRank, subRank: 0 } }],
        ranks: [{ id: firstRank, name: 'First', color: '#ffffff', subRanks: [] }, { id: nextRank, name: 'Second', color: '#0000ff', subRanks: [] }],
        criteria: [{ programId, rankId: nextRank, criterionId: 'classes', labelKey: 'ranks/ranks:classes', current: 4, required: 10, eligible: false }],
      });
      if (path.endsWith('/attendance')) return answer([{ id: id(10), memberId, sessionId, sessionName: 'Evening fundamentals', programId,
        occurredAt: new Date().toISOString(), source: 'kiosk', kind: 'class' }], { limit: 20, offset: 0, total: 1 });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/portal');
    await expect(page.getByText('Evening fundamentals', { exact: true })).toBeVisible();
    await expect(page.getByText('Unsigned waivers: 2')).toBeVisible();
    await expect(page.getByText('Unpaid invoices: 2')).toBeVisible();
    await expect(page.getByText('Current: First')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Show check-in code' })).toHaveAttribute('href', '/portal/checkin');
    await accessibleLayout(page, info, 'portal-home-' + width);
    await info.attach('portal-home-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.goto(gymOrigin + '/portal/progress');
    await expect(page.getByText('Evening fundamentals · Grappling')).toBeVisible();
    await accessibleLayout(page, info, 'portal-named-attendance-' + width);
    await info.attach('portal-named-attendance-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    const previousReads = invoiceReads; role = 'member';
    await page.goto(gymOrigin + '/portal');
    await expect(page.getByText('Unsigned waivers: 2')).toBeVisible();
    await expect(page.getByRole('link', { name: 'View invoices' })).toHaveCount(0);
    expect(invoiceReads).toBe(previousReads);
  });
}

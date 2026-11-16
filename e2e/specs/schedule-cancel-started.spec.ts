// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`started session cancellation controls at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: new Date('2026-11-11T12:00:00Z') });
    const id = '01900000-0000-7000-8000-000000000001';
    const session = { id, name: 'Midday practice', startsAt: '2026-11-11T12:01:00Z', endsAt: '2026-11-11T13:01:00Z',
      cancelBefore: '2026-11-11T11:01:00Z',
      templateId: null, coachId: null, status: 'scheduled', capacity: null, notes: null, kind: 'class',
      programIds: [id], tagIds: [], revision: 1, createdAt: '2026-11-01T00:00:00Z' };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const list = (data: unknown[]) => ({ data, pagination: { offset: 0, limit: 100, total: data.length } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id, name: 'Our Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId: id, displayName: 'Owner', roles: ['owner'], member: false }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/schedule/options') return route.fulfill({ json: { data: { timezone: 'UTC', programs: [{ id, name: 'Practice' }], coaches: [] } } });
      if (path === '/api/schedule/sessions') return route.fulfill({ json: list([session]) });
      if (path === `/api/bookings/sessions/${id}/roster`) return route.fulfill({ json: { ...list([]), counts: { booked: 0, waitlisted: 0, checkedIn: 0 } } });
      if (path.endsWith('/cancel')) return route.fulfill({ status: 409, json: { error: { code: 'conflict',
        message: 'Session started', details: { reason: ['session_started'] } } } });
      if (path === '/api/schedule/sessions/' + id) return route.fulfill({ json: { data: session } });
      return route.fulfill({ json: list([]) });
    });
    await page.goto(gymOrigin + '/admin/schedule');
    await page.getByRole('button').filter({ hasText: 'Midday practice' }).click();
    await expect(page.getByRole('button', { name: 'Cancel session', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel session', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'This session has started and cannot be cancelled.' })).toBeVisible();
    await accessibleLayout(page, info, 'started-refusal');
    await page.screenshot({ path: info.outputPath(`schedule-refusal-${width}.png`), fullPage: true });
    await page.clock.fastForward(61_000);
    await expect(page.getByRole('button', { name: 'Cancel session', exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /Email the/ })).toHaveCount(0);
    await accessibleLayout(page, info, 'started-controls-hidden');
    await page.screenshot({ path: info.outputPath(`schedule-started-${width}.png`), fullPage: true });
  });
}

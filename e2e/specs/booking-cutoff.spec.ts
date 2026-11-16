// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const sessionId = id(1), memberId = id(2), householdId = id(3);
const cutoff = '2026-11-11T12:01:00Z';
const session = { id: sessionId, name: 'Midday practice', startsAt: '2026-11-11T13:01:00Z', endsAt: '2026-11-11T14:01:00Z',
  cancelBefore: cutoff, templateId: null, coachId: null, status: 'scheduled', capacity: 1, notes: null, kind: 'class',
  programIds: [sessionId], tagIds: [], revision: 1, createdAt: '2026-11-01T00:00:00Z' };
const member = { id: memberId, householdId, firstName: 'River', lastName: 'Lee', status: 'active', email: null, phone: null,
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  photoKey: null, dateOfBirth: null, emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null,
  revision: 1, createdAt: session.createdAt };

for (const width of [360, 1280]) {
  for (const view of ['roster', 'member', 'portal', 'cancelled'] as const) {
    test(`booking cutoff and ${view} feedback at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 });
      // Fix Date while leaving scheduling timers live so the app can finish its initial queries.
      await page.clock.setFixedTime(new Date('2026-11-11T12:00:00Z'));
      let cancelled = false;
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const list = (data: unknown[]) => ({ data, pagination: { offset: 0, limit: 100, total: data.length } });
        const answer = (data: unknown) => route.fulfill({ json: { householdId, data } });
        if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
        if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
          gym: { id: id(4), name: 'Our Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
          session: { userId: id(5), displayName: 'River Lee', roles: view === 'portal' ? [] : [view === 'cancelled' ? 'owner' : 'front_desk'], member: view === 'portal' },
          login: { password: true, magicLink: false },
        } } });
        if (path === '/api/schedule/options') return route.fulfill({ json: { data: { timezone: 'UTC', programs: [{ id: sessionId, name: 'Practice' }], coaches: [] } } });
        if (path === '/api/schedule/sessions') return route.fulfill({ json: list([session]) });
        if (path === '/api/schedule/sessions/' + sessionId) return route.fulfill({ json: { data: { ...session, ...(cancelled ? { status: 'cancelled', revision: 2 } : {}) } } });
        if (path === `/api/bookings/sessions/${sessionId}/roster`) return route.fulfill({ json: { ...list([]), counts: { booked: 1, waitlisted: 0, checkedIn: 0 } } });
        if (path === '/api/members/' + memberId) return route.fulfill({ json: { data: member } });
        if (path === '/api/members') return route.fulfill({ json: list([member]) });
        if (path === '/api/households/' + householdId) return route.fulfill({ json: { data: { id: householdId, name: 'Lee', email: null, phone: null, sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, revision: 1, createdAt: session.createdAt } } });
        if (path.endsWith('/cancel')) {
          cancelled = true;
          return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Already cancelled', details: { reason: ['already_cancelled'] } } } });
        }
        if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Lee', role: 'payer' }] } } });
        if (path === '/api/portal/context') return answer({ role: 'payer', memberId });
        if (path === '/api/portal/schedule/members') return answer([{ id: memberId, name: 'River Lee' }]);
        if (path === '/api/portal/schedule') {
          const { id: sessionId, name, startsAt, endsAt, coachId, capacity, status, revision, cancelBefore } = session;
          return route.fulfill({ json: { householdId, ...list([{ id: sessionId, name, startsAt, endsAt, coachId, capacity, status, revision, cancelBefore,
            bookingOpensAt: '2026-11-01T00:00:00Z', placesLeft: 0, bookings: [] }]) } });
        }
        return route.fulfill({ json: list([]) });
      });
      if (view === 'portal') {
        await page.goto(gymOrigin + '/portal/schedule');
        await expect(page.getByRole('button', { name: /Join the waitlist:/ })).toBeVisible();
      } else if (view === 'member') {
        await page.goto(gymOrigin + `/admin/members/${memberId}#memberTabs.bookings`);
        await page.getByRole('tabpanel', { name: 'Bookings', exact: true }).getByLabel('Class', { exact: true }).selectOption(sessionId);
      } else {
        await page.goto(gymOrigin + '/admin/schedule');
        await page.getByRole('button').filter({ hasText: 'Midday practice' }).click();
      }
      if (view === 'cancelled') {
        await page.getByRole('checkbox', { name: /Email the 1 booked/ }).check();
        await page.getByRole('button', { name: 'Cancel session', exact: true }).click();
        await expect(page.getByText('This session is already cancelled. No cancellation notice was queued.')).toBeVisible();
        await expect(page.getByRole('button', { name: 'Cancel session', exact: true })).toBeDisabled();
        await page.getByText('This session is already cancelled. No cancellation notice was queued.').scrollIntoViewIfNeeded();
      } else {
        await page.clock.setFixedTime(new Date(cutoff));
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        const option = view === 'portal' ? page.getByRole('button', { name: /Join the waitlist:/ }) : page.getByRole('checkbox', { name: 'Join the waitlist if the class is full' });
        await expect(option).toBeVisible(); // Exact cutoff remains allowed.
        await page.clock.setFixedTime(new Date(Date.parse(cutoff) + 1));
        await expect(option).toHaveCount(0);
        if (view === 'portal') await expect(page.getByText('The waitlist is closed. The cancellation cutoff has passed.')).toBeVisible();
        if (view === 'roster') await page.getByRole('button', { name: 'Book a place', exact: true }).scrollIntoViewIfNeeded();
      }
      await accessibleLayout(page, info, `booking-${view}-${width}`);
      await info.attach(`booking-${view}-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
  }
}

// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const gymId = id(1), userId = id(2), householdId = id(3), memberId = id(4);

// These API fixtures exercise offline navigation in the production bundle without session credentials.
test('a section not visited yet opens offline under the header and banner', async ({ page, context }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
    if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
      gym: { id: gymId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId, displayName: 'Pat Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
    } } });
    if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera household', role: 'payer' }] } } });
    if (path === '/api/portal/context') return route.fulfill({ json: { householdId, data: { role: 'payer', memberId } } });
    if (path === '/api/portal/household') return route.fulfill({ json: { householdId, data: { id: householdId, name: 'Rivera household', email: 'pat@example.test', phone: null, sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, billingDay: 1, revision: 1 } } });
    if (path === '/api/portal/members') return route.fulfill({ json: { householdId, data: [{ id: memberId, firstName: 'Pat', lastName: 'Rivera', email: null,
      phone: null, sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null }, dateOfBirth: '1980-04-02', photoKey: null, status: 'active', emergencyContacts: [], revision: 1 }], pagination: { limit: 100, offset: 0, total: 1 } } });
    if (path.endsWith('/memberships')) return route.fulfill({ json: { householdId, data: [], pagination: { limit: 100, offset: 0, total: 0 } } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(gymOrigin + '/portal/household');
  await expect(page.getByLabel('Phone', { exact: true })).toBeVisible();
  // The other sections' code loads in the background; wait for it before the connection drops.
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);
  await page.getByRole('navigation', { name: 'Member navigation' }).getByRole('link', { name: 'Progress', exact: true }).click();
  await expect(page).toHaveURL(/\/portal\/progress$/);
  // The address changes before the section's code runs, and the header and banner are on the page being left too. Only
  // the opened section replaces that page with its own loading state, which a reload for missing code never reaches.
  await expect(page.getByLabel('Phone', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('main').locator('[data-loading]')).toBeVisible();
  await expect(page.getByRole('banner').getByText('Test Gym', { exact: true })).toBeVisible();
  await expect(page.getByText('You are offline. Connect to the internet to use the member portal.', { exact: true })).toBeVisible();
  await context.setOffline(false);
});

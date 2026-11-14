// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const gymId = id(1), userId = id(2), householdId = id(3), memberId = id(4), systemId = id(5), rankId = id(6);
const createdAt = '2026-09-01T12:00:00.000Z';
const list = (data: unknown[]) => ({ data, pagination: { limit: 100, offset: 0, total: data.length } });

// Fixture responses exercise the production forms and request parsing at both widths.
for (const width of [360, 1280]) {
  test(`household and member saves omit unchanged fields at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const home = { id: householdId, name: 'Rivera household', email: 'pat@example.test', phone: null as string | null,
      address: { line1: '1 Main St' }, billingDay: 1, revision: 1 };
    const person = { id: memberId, firstName: 'Pat', lastName: 'Rivera', email: null, phone: null as string | null,
      dateOfBirth: '1980-04-02', photoKey: null, status: 'active', revision: 1,
      emergencyContacts: [{ name: 'Grandparent', relationship: null, phone: '555-0100', future: true }] };
    const writes: { path: string; body: unknown }[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: gymId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId, displayName: 'Pat Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') return route.fulfill({ json: { data: { current: householdId,
        households: [{ householdId, name: home.name, role: 'payer' }] } } });
      if (path === '/api/portal/context') return route.fulfill({ json: { householdId, data: { role: 'payer', memberId } } });
      if (route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); writes.push({ path, body });
        if (path === '/api/portal/household') { home.phone = body.phone; home.revision++; }
        if (path === `/api/portal/members/${memberId}`) { person.phone = body.phone; person.revision++; }
      }
      if (path === '/api/portal/household') return route.fulfill({ json: { householdId, data: home } });
      if (path === '/api/portal/members') return route.fulfill({ json: { householdId, ...list([person]) } });
      if (path === `/api/portal/members/${memberId}`) return route.fulfill({ json: { householdId, data: person } });
      if (path.endsWith('/memberships')) return route.fulfill({ json: { householdId, ...list([]) } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/portal/household');
    await page.getByLabel('Phone', { exact: true }).fill('555-0199');
    await accessibleLayout(page, info, 'household-form');
    await info.attach('household-' + width, { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
    expect(writes).toEqual([{ path: '/api/portal/household', body: { phone: '555-0199', revision: 1 } }]);
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Phone', { exact: true }).fill('555-0188');
    await accessibleLayout(page, info, 'member-form');
    await info.attach('member-' + width, { body: await dialog.screenshot(), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(writes.slice(1)).toEqual([{ path: `/api/portal/members/${memberId}`, body: { phone: '555-0188', revision: 1 } }]);
  });

  test(`rank saves omit unchanged nested fields at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const rank = { id: rankId, gymId, rankSystemId: systemId, createdAt, revision: 1, name: 'Foundation', position: 0, color: '#ffffff',
      subRanks: [{ id: 'tip', name: 'Tip', future: true }], criteria: [{ providerId: 'minimum-age', config: { target: 16 }, future: true }] };
    const writes: unknown[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: gymId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId, displayName: 'Test Owner', roles: ['owner'], member: false }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/rank-systems') return route.fulfill({ json: list([{ id: systemId, gymId, createdAt, revision: 1, name: 'Progression', installedPackId: null }]) });
      if (path === '/api/programs' || path === '/api/members') return route.fulfill({ json: list([]) });
      if (path === '/api/ranks') return route.fulfill({ json: list([rank]) });
      if (path === `/api/ranks/${rankId}` && route.request().method() === 'PATCH') {
        const body = route.request().postDataJSON(); writes.push(body); rank.name = body.name; rank.revision++;
        return route.fulfill({ json: { data: rank } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/ranks');
    await page.getByRole('button', { name: 'Edit Foundation', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Renamed');
    await accessibleLayout(page, info, 'rank-form');
    await info.attach('rank-' + width, { body: await dialog.screenshot(), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(writes).toEqual([{ name: 'Renamed', revision: 1 }]);
  });
}

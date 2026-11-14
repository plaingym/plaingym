// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleThemes } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'A gym getting ready for its first members', timezone: 'UTC', currency: 'USD', enabledModules: ['website'] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const settings = { id: gym.id, name: gym.name, timezone: 'UTC', currency: 'USD', slug: 'first-gym', address: {}, branding: { primaryColor: '#155e55' },
  websiteEnabled: true, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
  createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };

// Fixtures exercise the production bundle without adding data to the shared install.
for (const width of [360, 1280]) test(`settings sections and an empty dashboard at ${width}px in both themes`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 800 });
  let rosterReady = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
    if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login: { password: true, magicLink: false } } } });
    if (path === '/api/settings') return route.fulfill(route.request().method() === 'GET' ? { json: { data: settings } }
      : { status: 500, json: { error: { code: 'internal_error' } } });
    if (path === '/api/settings/go-live') return route.fulfill({ json: { data: { revision: 3, billingEnabled: false, memberEmailsEnabled: false,
      items: [{ id: 'members_imported', status: rosterReady ? 'ready' : 'needs_attention', message: 'Add your first members.' }] } } });
    if (path === '/api/website') return route.fulfill({ json: { data: { revision: 3, tagline: null, about: null, phone: null, email: null,
      primaryColor: '#155e55', accentColor: '#e3eeec', logo: false, logoVersion: null, photos: [] } } });
    if (path === '/api/settings/integrations/google') return route.fulfill({ json: { data: { source: 'none', editable: false,
      unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: 3 } } });
    if (path === '/api/dashboard') return route.fulfill({ json: { data: { generatedAt: '2026-11-01T12:00:00Z',
      widgets: [{ id: 'active_members', titleKey: 'dashboard/dashboard:widget.active_members', status: 'ready', count: 0 }] } } });
    // Unrelated sections' unavailable reads stay local and safely rendered.
    return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
  });
  await page.goto(gymOrigin + '/admin/settings');
  const menu = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(menu.getByRole('link').first()).toHaveText('Gym details');
  await expect(menu.getByRole('link', { name: 'Google sign-in' })).toHaveCount(0);
  await expect(page.locator('main section[id]').first()).toHaveAttribute('id', 'settingsSections.settings.general');
  await expect(page.locator('input[type="color"]')).toHaveCount(1);
  await expect(page.getByLabel('Logo storage key')).toBeHidden();
  await page.getByText('Advanced logo settings', { exact: true }).click();
  await expect(page.getByLabel('Logo storage key')).toBeVisible();
  await expect(page.getByText(/This is the storage reference/)).toBeVisible();
  const details = page.getByRole('form', { name: 'Gym details', exact: true });
  await details.getByRole('button', { name: 'Save changes' }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'Unable to save or load settings.' }).first();
  await expect(failure).toHaveAttribute('data-variant', 'error');
  await expect(failure).toBeFocused();
  await accessibleThemes(page, info, 'settings-sections-failure-' + width);
  await menu.getByRole('link', { name: 'Go-live', exact: true }).click();
  await expect(page).toHaveURL(/#settingsSections.settings.go-live$/);
  await page.goto(gymOrigin + '/admin');
  await expect(page.getByRole('heading', { name: 'Get your gym ready' })).toBeVisible();
  for (const name of ['Add classes', 'Add membership plans', 'Add members', 'Import members', 'Review go-live checklist'])
    await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
  await accessibleThemes(page, info, 'dashboard-getting-started-' + width);
  rosterReady = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Active members' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get your gym ready' })).toHaveCount(0);
});

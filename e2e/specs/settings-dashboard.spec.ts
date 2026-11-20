// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleThemes } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'A gym getting ready for its first members', timezone: 'UTC', currency: 'USD', enabledModules: ['website'] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const settings = { id: gym.id, name: gym.name, timezone: 'UTC', currency: 'USD', slug: 'first-gym', address: {}, branding: { primaryColor: '#155e55' },
  websiteEnabled: true, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, bankDebitsEnabled: false, memberEmailsEnabled: false, memberSmsEnabled: false, smsDailyCap: 1000, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3,
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
      memberSmsEnabled: false,
      items: [{ id: 'members_imported', status: rosterReady ? 'ready' : 'needs_attention', message: 'Add your first members.' },
        { id: 'reconciliation_complete', status: 'needs_attention', message: 'Resolve pending payment attempts or refunds. The last check read Stripe test mode. Check restored payments again in live mode before turning billing on.' }],
      restoreReconciliation: { restoreId: '00000000-0000-7000-8000-000000000003', snapshotAt: '2026-11-01T12:00:00Z',
        checkedAt: '2026-11-02T12:00:00Z', inspected: 0, unresolved: 0, stripeConfigured: true, stripeMode: 'test' },
    } } });
    if (path === '/api/settings/integrations') return route.fulfill({ json: { data: { revision: 3, sandbox: false, integrationsEditable: true,
      sms: { configured: false, provider: 'twilio', unreadable: false, accountSid: null, authKind: null, from: null, messagingServiceSid: null },
      email: { source: 'none', unreadable: false, googleConfigured: false, host: null, port: null, security: null, from: null,
        signIn: { password: true, magicLink: false }, signInAfterSave: { password: false, magicLink: true }, signInAfterRemove: null, removeBlocked: false },
      payments: { configured: true, mode: 'live', webhookRegistered: true, accountLocked: false, testData: null, importedCustomersOnly: false },
      backups: null,
    } } });
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
  const modeNote = page.getByRole('note').filter({ hasText: 'The last check read Stripe test mode.' });
  await expect(modeNote).toHaveCount(2);
  await expect(modeNote.first()).toContainText('again in live mode before turning billing on');
  await expect(modeNote.first()).toContainText('Resolve pending payment attempts or refunds.');
  await expect(page.getByLabel('Logo storage key')).toHaveCount(0);
  await expect(page.getByText('Advanced logo settings', { exact: true })).toHaveCount(0);
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
  await page.getByRole('link', { name: 'Review go-live checklist', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/settings#settingsSections.settings.go-live$/);
  const goLive = page.locator('section[id="settingsSections.settings.go-live"]');
  await expect(goLive).toBeFocused();
  await expect(goLive).toBeInViewport();
  const headerBottom = await page.locator('header').first().evaluate(header => header.getBoundingClientRect().bottom);
  await expect.poll(async () => (await goLive.getByRole('heading', { name: 'Go-live', exact: true }).boundingBox())?.y ?? -1)
    .toBeGreaterThanOrEqual(headerBottom);
  await accessibleThemes(page, info, 'settings-go-live-from-dashboard-' + width);
  rosterReady = true;
  await page.goto(gymOrigin + '/admin');
  await expect(page.getByRole('heading', { name: 'Active members' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Get your gym ready' })).toHaveCount(0);
});

for (const width of [360, 1280]) test(`website saves after a brand color change at ${width}px`, async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width, height: 800 });
  let current = { ...settings }, saves = 0;
  let website = { revision: current.revision, tagline: 'Train together', about: null, phone: null, email: null,
    primaryColor: current.branding.primaryColor, accentColor: '#112233' as string | null, logo: false, logoVersion: null, photos: [] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
    if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login: { password: true, magicLink: false } } } });
    if (path === '/api/settings') {
      if (route.request().method() !== 'GET') {
        current = { ...current, ...route.request().postDataJSON(), revision: current.revision + 1 };
        website = { ...website, primaryColor: current.branding.primaryColor, revision: current.revision };
      }
      return route.fulfill({ json: { data: current } });
    }
    if (path === '/api/website') {
      if (route.request().method() === 'PUT') {
        saves++;
        const body = route.request().postDataJSON();
        expect(body).toMatchObject({ revision: current.revision, primaryColor: '#123456', tagline: 'Unsaved website text' });
        expect(body).not.toHaveProperty('accentColor');
        current = { ...current, revision: current.revision + 1 };
        website = { ...website, ...body, accentColor: null, revision: current.revision };
      }
      return route.fulfill({ json: { data: website } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
  });
  await page.goto(gymOrigin + '/admin/settings');
  await page.getByRole('textbox', { name: 'Tagline' }).fill('Unsaved website text');
  await page.getByRole('link', { name: 'Change your brand color in Gym details' }).click();
  await page.locator('input[type="color"]').fill('#123456');
  await page.getByRole('form', { name: 'Gym details', exact: true }).getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Website', exact: true }).click();
  const save = page.getByRole('button', { name: 'Save website', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Website saved.', { exact: true })).toBeVisible();
  expect(saves).toBe(1);
  await accessibleThemes(page, info, 'website-after-brand-save-' + width);
});

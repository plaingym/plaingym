// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const gymId = id(1), userId = id(2), householdId = id(3), memberId = id(4);

// These API fixtures exercise recovery presentation in the production bundle without session credentials.
for (const width of [360, 1280]) {
  test(`portal recovery keeps notices visible in the page and editor at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.clock.install();
    let recovering = false, initialLists = true, releaseLists: (() => void) | undefined;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id: gymId, name: 'Test Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId, displayName: 'Pat Rivera', roles: [], member: true }, login: { password: true, magicLink: false },
      } } });
      if (path === '/api/portal/households') {
        if (!initialLists && recovering) {
          await new Promise<void>(resolve => { releaseLists = resolve; });
          return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
        }
        initialLists = false;
        return route.fulfill({ json: { data: { current: householdId, households: [{ householdId, name: 'Rivera household', role: 'payer' }] } } });
      }
      if (path === '/api/portal/context') return route.fulfill({ json: { householdId, data: { role: 'payer', memberId } } });
      if (path === '/api/portal/household') {
        if (recovering) return route.fulfill({ status: 409, headers: { 'X-Portal-Household': id(99) }, json: { error: { code: 'conflict' } } });
        return route.fulfill({ json: { householdId, data: { id: householdId, name: 'Rivera household', email: 'pat@example.test', phone: null, address: {}, billingDay: 1, revision: 1 } } });
      }
      if (path === '/api/portal/members') return route.fulfill({ json: { householdId, data: [{ id: memberId, firstName: 'Pat', lastName: 'Rivera', email: null,
        phone: null, dateOfBirth: '1980-04-02', photoKey: null, status: 'active', emergencyContacts: [], revision: 1 }], pagination: { limit: 100, offset: 0, total: 1 } } });
      if (path.endsWith('/memberships')) return route.fulfill({ json: { householdId, data: [], pagination: { limit: 100, offset: 0, total: 0 } } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/portal/household');
    await expect(page.getByLabel('Phone', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Edit details', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('First name').fill('Draft');
    const container = page.locator('main .max-w-3xl');
    const originalHeight = await container.evaluate(element => element.getBoundingClientRect().height);
    await page.clock.fastForward(31_000);
    recovering = true;
    await page.evaluate(() => {
      // Native visibility events bubble to Query's window listener.
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    await expect(dialog).toBeHidden();
    expect(await container.evaluate(element => element.getBoundingClientRect().height)).toBe(originalHeight);
    await expect.poll(() => !!releaseLists).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 200));
    releaseLists!();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('First name')).toHaveValue('Draft');
    await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
    await accessibleLayout(page, info, 'recovery-editor');
    await info.attach('recovery-editor-' + width, { body: await page.screenshot(), contentType: 'image/png' });
    await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toBeHidden();
    const alert = page.getByRole('alert');
    await container.evaluate(element => {
      const filler = document.createElement('div'); filler.style.height = '1200px'; filler.setAttribute('aria-hidden', 'true');
      element.querySelector('[inert], .space-y-6')!.append(filler);
      window.scrollTo(0, 400);
    });
    const bounds = await alert.boundingBox(), pageBounds = await container.boundingBox();
    expect(bounds).not.toBeNull(); expect(pageBounds).not.toBeNull();
    expect(bounds!.x).toBeCloseTo(pageBounds!.x, 0);
    expect(bounds!.width).toBeCloseTo(pageBounds!.width, 0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeLessThan(40);
    await accessibleLayout(page, info, 'recovery-page');
    await info.attach('recovery-page-' + width, { body: await page.screenshot(), contentType: 'image/png' });
  });
}

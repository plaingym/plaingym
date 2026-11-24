// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout, reachable } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Setup test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const login = { password: true, magicLink: false };
const before = { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5], completed: false, revision: 3, googleSkipped: true, backupsLater: false };
const after = { currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6], completed: false, revision: 4, googleSkipped: true, backupsLater: false };

// API fixtures walk the payments step's successful connection in the production bundle without contacting Stripe.
for (const width of [360, 1280]) {
  test(`setup confirms a test-mode Stripe connection and continues to backups at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let connected = false;
    const stripeRequests: unknown[] = [];
    const unexpected: string[] = [];
    // The key is built at runtime so no credential-shaped literal sits in the source.
    const restrictedKey = 'rk_test_' + 'abcdefghijklmnopqrstuvwx';
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login } } });
      if (path === '/api/setup' && request.method() === 'GET') return route.fulfill({ json: { data: connected ? after : before } });
      if (path === '/api/setup/stripe' && request.method() === 'PUT') {
        stripeRequests.push(request.postDataJSON());
        connected = true;
        return route.fulfill({ json: { data: { configured: true, mode: 'test', webhookRegistered: true, revision: 4 } } });
      }
      unexpected.push(request.method() + ' ' + path);
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    try {
      await page.goto(gymOrigin + '/setup#token=fixture');
      await page.getByLabel('Restricted Stripe key', { exact: true }).fill(restrictedKey);
      await page.getByRole('button', { name: 'Validate and connect', exact: true }).click();

      const status = page.getByRole('status').filter({ hasText: 'Connected in test mode.' });
      await expect(status).toHaveText(`Connected in test mode. Webhook registered at ${new URL('/webhooks/stripe', gymOrigin).href}.`);
      expect(stripeRequests).toEqual([{ choice: 'configure', revision: 3, restrictedKey }]);
      const next = page.getByRole('button', { name: 'Continue to backups', exact: true });
      await expect(next).toBeVisible();
      await reachable(next, page);
      await accessibleLayout(page, info, 'setup-stripe-connected-' + width);
      await page.screenshot({ path: info.outputPath('setup-stripe-connected-' + width + '.png'), fullPage: true });

      await next.click();
      await expect(page.getByRole('heading', { name: 'Protect your gym with backups', exact: true })).toBeVisible();
    } finally {
      expect(unexpected).toEqual([]);
    }
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

// Fixture reports exercise the two notices; real saves and reconciliation are covered by server database tests.
for (const width of [360, 1280]) test('restore checks explain connecting Stripe at ' + width + ' px', async ({ install, page }, info) => {
  await install.clients.owner.browser(page.context());
  await page.setViewportSize({ width, height: 900 });
  let connected = false;
  await page.route(gymOrigin + '/api/settings/go-live', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.billingEnabled = false;
    body.data.restoreReconciliation = { restoreId: '00000000-0000-7000-8000-000000000003',
      snapshotAt: '2026-11-01T12:00:00Z', checkedAt: '2026-11-02T12:00:00Z', inspected: 3, unresolved: 0, stripeConfigured: false };
    body.data.items = body.data.items.map((item: { id: string; status: string }) => item.id === 'stripe_ready'
      ? { ...item, status: connected ? 'ready' : 'needs_attention' } : item);
    await route.fulfill({ response, json: body });
  });
  await page.route(gymOrigin + '/api/settings/integrations', async route => {
    const response = await route.fetch(), body = await response.json();
    body.data.sandbox = false; body.data.integrationsEditable = true;
    body.data.payments = { ...body.data.payments, configured: connected, mode: connected ? 'test' : null, webhookRegistered: connected };
    await route.fulfill({ response, json: body });
  });
  await page.goto(gymOrigin + '/admin/settings');
  const restored = page.getByLabel('Restored payments', { exact: true });
  await expect(restored.getByText(/Stored references: 3/)).toBeVisible();
  await expect(restored.getByText(/last check ran without Stripe and only read restored records/)).toBeVisible();
  await accessibleLayout(page, info, 'restore-without-stripe-' + width);
  await info.attach('restore-without-stripe-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  connected = true;
  await page.reload();
  await expect(restored.getByText(/last restore check ran without Stripe/)).toBeVisible();
  const paymentsNotice = page.getByRole('note').filter({ hasText: 'The last restore check ran without Stripe.' });
  await expect(paymentsNotice).toContainText('Check restored payments again');
  await accessibleLayout(page, info, 'restore-stripe-connected-' + width);
  await info.attach('restore-stripe-connected-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

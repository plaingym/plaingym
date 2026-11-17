// SPDX-License-Identifier: AGPL-3.0-only
import { expect, gymOrigin, test } from '../support.js';
import { check, open, viewports } from './mobile-screens.js';

for (const viewport of viewports) {
  test(`exhausted invoice effects and confirmations at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), exhaustedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const actions: string[] = [];
    let effects = [
      { effectId: '00000000-0000-4000-8000-000000000001', invoiceId: '00000000-0000-4000-8000-000000000003',
        number: 42, kind: 'refund_duplicate', refund: { amountCents: 12500, currency: 'USD' }, exhaustedAt },
      { effectId: '00000000-0000-4000-8000-000000000002', invoiceId: '00000000-0000-4000-8000-000000000004',
        number: 43, kind: 'receipt', refund: null, exhaustedAt },
    ];
    try {
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      await page.route('**/api/health', route => route.fulfill({ json: { data: { ...body.data, tiles: body.data.tiles.map(tile => tile.id === 'invoice_effects'
        ? { ...tile, status: effects.length ? 'error' : 'healthy', checkedAt: now, details: { exhausted: effects.length }, message: 'Invoice effects need attention.' }
        : { ...tile, status: 'not_configured', checkedAt: now, details: null, message: 'Not set up' }) } } }));
      await page.route('**/api/health/effect-failures', route => route.fulfill({ json: { data: effects } }));
      await page.route('**/api/health/effect-failures/*', route => {
        const { effectId } = route.request().postDataJSON() as { effectId: string };
        actions.push(route.request().url().split('/').at(-1)! + ':' + effectId);
        effects = effects.filter(effect => effect.effectId !== effectId);
        return route.fulfill({ json: { data: { changed: true } } });
      });
      await page.goto(gymOrigin + '/admin/health');
      await expect(page.getByRole('link', { name: 'Invoice #42', exact: true })).toHaveAttribute('href', '/admin/billing/invoices/00000000-0000-4000-8000-000000000003');
      await check(page, info, `${viewport.name}-exhausted-effects`);
      const refund = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: 'Invoice #42', exact: true }) });
      await refund.getByRole('button', { name: 'Retry', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText(/duplicate payment's \$125.00 to the card now/)).toBeVisible();
      await expect(dialog.getByText(/Recovery exhausted 2 days ago/)).toBeVisible();
      expect(actions).toEqual([]);
      await check(page, info, `${viewport.name}-refund-confirmation`);
      await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'Invoice #42', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(dialog.getByText('This sends the receipt email now.')).toBeVisible();
      await check(page, info, `${viewport.name}-email-confirmation`);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(dialog.getByText(/handled by hand or no longer needs to run/)).toBeVisible();
      await check(page, info, `${viewport.name}-dismiss-confirmation`);
      await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Effects needing attention' })).toHaveCount(0);
      expect(actions).toEqual(['retry:00000000-0000-4000-8000-000000000001', 'dismiss:00000000-0000-4000-8000-000000000002']);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await context.close(); }
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, gymOrigin, test } from '../support.js';
import { check, open, viewports } from './mobile-screens.js';

for (const viewport of viewports) {
  test(`backup hold warning and definite request retry at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), requests: string[] = [];
    const control = { available: true, configured: true, pruningHeld: true, revision: 1,
      manual: null as null | { requestId: string; status: string; requestedAt: string; completedAt: null; snapshotId: null } };
    try {
      // Render the held state without changing the install's actual backup destination or taking a snapshot.
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      body.data.tiles = body.data.tiles.map(tile => tile.id === 'last_backup' ? {
        id: 'last_backup', status: 'warning', checkedAt: now,
        message: 'Backup pruning is on hold until the owner confirms the old server is gone. New snapshots stop when the retained backups reach the retention budget.',
        details: { latestRestorableAt: now, ageSeconds: 0, overdue: false, noneUnderCurrentKey: false,
          retainedBytes: 1024, retentionBudgetBytes: 8_000_000_000, pruningStopped: false, pruningHeld: true, keyReminder: true },
      } : { ...tile, status: 'not_configured', checkedAt: now, details: null, message: 'Not set up' });
      await page.route('**/api/health', route => route.fulfill({ json: body }));
      await page.route('**/api/health/backups', route => route.fulfill({ json: { data: control } }));
      await page.route('**/api/health/backups/now', route => {
        const { requestId } = route.request().postDataJSON() as { requestId: string };
        requests.push(requestId);
        if (requests.length === 1) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'Request already finished' } } });
        control.manual = { requestId, status: 'queued', requestedAt: now, completedAt: null, snapshotId: null };
        return route.fulfill({ json: { data: control } });
      });
      await page.goto(gymOrigin + '/admin/health');
      await expect(page.getByRole('heading', { name: 'Last backup', exact: true })).toBeVisible();
      await expect(page.getByText(/Backup pruning is on hold.*retention budget/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
      await check(page, info, `${viewport.name}-backup-hold`);
      await page.getByRole('button', { name: 'Back up now', exact: true }).click();
      await expect(page.getByText(/Unable to confirm the backup request/)).toBeVisible();
      await page.getByRole('button', { name: 'Back up now', exact: true }).click();
      await expect(page.getByText('Your backup is queued.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Backup in progress…', exact: true })).toBeDisabled();
      expect(requests).toHaveLength(2); expect(requests[0]).not.toBe(requests[1]);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await context.close(); }
  });
}

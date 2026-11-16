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

for (const viewport of viewports) {
  test(`health failure time and separate disk volumes at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), oldest = '2026-08-01T00:30:00.000Z';
    let staging = true;
    try {
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      await page.route('**/api/health', route => route.fulfill({ json: { data: { ...body.data,
        tiles: body.data.tiles.map(tile => tile.id === 'failed_jobs' ? {
          id: 'failed_jobs', status: 'error', checkedAt: now, message: '2 background jobs failed.',
          details: { failed: 2, pending: 1, running: 0, oldestFailureAt: oldest },
        } : tile.id === 'disk' ? {
          id: 'disk', status: staging ? 'warning' : 'healthy', checkedAt: now,
          message: staging ? 'Free space: uploads 10 GB; backup staging 0.5 GB.' : 'Free space: uploads 10 GB.',
          details: { uploads: { totalBytes: 20_000_000_000, availableBytes: 10_000_000_000 },
            backupStaging: staging ? { totalBytes: 8_000_000_000, availableBytes: 500_000_000 } : null },
        } : { ...tile, status: 'not_configured', checkedAt: now, details: null, message: 'Not set up' }),
      } } }));
      await page.goto(gymOrigin + '/admin/health');
      const jobs = page.locator('section, article').filter({ has: page.getByRole('heading', { name: 'Background jobs', exact: true }) });
      await expect(jobs.getByText('Problem detected', { exact: true })).toBeVisible();
      await expect(jobs.locator(`time[datetime="${oldest}"]`)).toBeVisible();
      const disk = page.locator('section, article').filter({ has: page.getByRole('heading', { name: 'Disk space', exact: true }) });
      for (const [label, value] of [['Uploads volume capacity', '20 GB'], ['Uploads volume available', '10 GB'],
        ['Backup staging volume capacity', '8 GB'], ['Backup staging volume available', '500 MB']]) {
        const row = disk.locator('dl > div').filter({ has: page.getByText(label!, { exact: true }) });
        await expect(row.locator('dd')).toHaveText(value!);
      }
      await expect(page.getByText('[object Object]', { exact: true })).toHaveCount(0);
      await check(page, info, `${viewport.name}-health-volumes`);
      staging = false;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(disk.getByText('Backup staging volume capacity', { exact: true })).toHaveCount(0);
      await expect(disk.getByText('Healthy', { exact: true })).toBeVisible();
      await expect(jobs.getByText('Problem detected', { exact: true })).toBeVisible();
      await check(page, info, `${viewport.name}-health-without-staging`);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await context.close(); }
  });
}

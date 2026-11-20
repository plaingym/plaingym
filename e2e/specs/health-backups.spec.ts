// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { expect, gymOrigin, test } from '../support.js';
import { check, open, viewports } from './mobile-screens.js';

const sourceUrl = 'https://example.test/source/v0.1.0';

function versionTile(checkedAt: string) {
  return {
    id: 'version', status: 'healthy', checkedAt, message: 'Running version 0.1.0.',
    details: { version: '0.1.0', sourceUrl },
  };
}

async function checkVersionSource(page: Page) {
  const link = page.getByRole('region', { name: 'Version', exact: true })
    .getByRole('link', { name: 'Source code', exact: true });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', sourceUrl);
  const box = (await link.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

for (const viewport of viewports) {
  test(`missing and damaged rollback snapshots at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), guard = '00000000-0000-4000-8000-000000000001';
    let missing = false;
    try {
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      await page.route('**/api/health', route => route.fulfill({ json: { data: { ...body.data,
        tiles: body.data.tiles.map(tile => tile.id === 'last_backup' ? {
          id: 'last_backup', status: 'warning', checkedAt: now,
          message: `The rollback snapshot is ${missing ? 'missing' : 'damaged'} and cannot be restored.`,
          details: { latestRestorableAt: now, ageSeconds: 0, overdue: false, retainedBytes: 1024,
            retentionBudgetBytes: 8_000_000_000, pruningStopped: false, keyReminder: true,
            damagedGuardSnapshot: missing ? null : guard, missingGuardSnapshot: missing ? guard : null },
        } : tile.id === 'version' ? versionTile(now) : tile),
      } } }));
      await page.goto(gymOrigin + '/admin/health');
      await expect(page.getByText('The rollback snapshot is damaged and cannot be restored.', { exact: true })).toBeVisible();
      await expect(page.getByText(`Rollback snapshot ${guard} is damaged`, { exact: false })).toBeVisible();
      await checkVersionSource(page);
      await check(page, info, `${viewport.name}-damaged-rollback`);
      missing = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(page.getByText('The rollback snapshot is missing and cannot be restored.', { exact: true })).toBeVisible();
      await expect(page.getByText(`Rollback snapshot ${guard} named by the active schema guard is missing`, { exact: false })).toBeVisible();
      await expect(page.getByText(/health\/status:|available for restore/)).toHaveCount(0);
      await check(page, info, `${viewport.name}-missing-rollback`);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await context.close(); }
  });
  test(`backup hold warning and definite request retry at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), requests: string[] = [];
    const damagedGuard = '00000000-0000-4000-8000-000000000001';
    const control = { available: true, configured: true, pruningHeld: true, revision: 1,
      manual: null as null | { requestId: string; status: string; requestedAt: string; completedAt: null; snapshotId: null } };
    try {
      // Render the held state without changing the install's actual backup destination or taking a snapshot.
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      body.data.tiles = body.data.tiles.map(tile => tile.id === 'last_backup' ? {
        id: 'last_backup', status: 'warning', checkedAt: now,
        message: 'Backup pruning is on hold until the owner confirms the old server is gone. New snapshots stop when the retained backups reach the retention budget.',
        details: { latestRestorableAt: now, ageSeconds: 0, overdue: false, noneUnderCurrentKey: false,
          retainedBytes: 1024, retentionBudgetBytes: 8_000_000_000, pruningStopped: false, pruningHeld: true,
          damagedGuardSnapshot: damagedGuard, keyReminder: true },
      } : tile.id === 'version' ? versionTile(now) : tile);
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
      await expect(page.getByText(`Rollback snapshot ${damagedGuard} is damaged and cannot be restored.`, { exact: false })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Back up now', exact: true })).toBeEnabled();
      await checkVersionSource(page);
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
  test(`health failure time and disk layouts at ${viewport.name} width`, async ({ browser, install }, info) => {
    const [context, page] = await open(browser, install, 'owner', viewport);
    const now = new Date().toISOString(), oldest = '2026-08-01T00:30:00.000Z';
    let layout: 'separate' | 'uploads' | 'shared' = 'separate';
    try {
      const body = await install.clients.owner.json<{ data: { tiles: { id: string }[] } }>('/api/health');
      await page.route('**/api/health', route => route.fulfill({ json: { data: { ...body.data,
        tiles: body.data.tiles.map(tile => tile.id === 'failed_jobs' ? {
          id: 'failed_jobs', status: 'error', checkedAt: now, message: '2 background jobs failed.',
          details: { failed: 2, pending: 1, running: 0, oldestFailureAt: oldest },
        } : tile.id === 'disk' ? {
          id: 'disk', status: layout === 'uploads' ? 'healthy' : 'warning', checkedAt: now,
          message: layout === 'shared' ? 'Free space: uploads and backup staging (one volume) 10 GB.'
            : layout === 'separate' ? 'Free space: uploads 10 GB; backup staging 0.5 GB.' : 'Free space: uploads 10 GB.',
          details: { uploads: { totalBytes: 20_000_000_000, availableBytes: 10_000_000_000 },
            backupStaging: layout === 'uploads' ? null
              : layout === 'shared' ? { totalBytes: 20_000_000_000, availableBytes: 10_000_000_000 }
              : { totalBytes: 8_000_000_000, availableBytes: 500_000_000 }, sameFilesystem: layout === 'shared' },
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
      layout = 'uploads';
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(disk.getByText('Backup staging volume capacity', { exact: true })).toHaveCount(0);
      await expect(disk.getByText('Healthy', { exact: true })).toBeVisible();
      await expect(jobs.getByText('Problem detected', { exact: true })).toBeVisible();
      await check(page, info, `${viewport.name}-health-without-staging`);
      layout = 'shared';
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      for (const [label, value] of [['Uploads and backup staging volume capacity', '20 GB'],
        ['Uploads and backup staging volume available', '10 GB']]) {
        const row = disk.locator('dl > div').filter({ has: page.getByText(label!, { exact: true }) });
        await expect(row.locator('dd')).toHaveText(value!);
      }
      for (const separate of ['Uploads volume capacity', 'Uploads volume available',
        'Backup staging volume capacity', 'Backup staging volume available']) await expect(disk.getByText(separate, { exact: true })).toHaveCount(0);
      await check(page, info, `${viewport.name}-health-shared-volume`);
    } finally { await page.unrouteAll({ behavior: 'wait' }); await context.close(); }
  });
}

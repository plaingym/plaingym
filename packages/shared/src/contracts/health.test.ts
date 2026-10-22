// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { healthTileIds, healthTileSchema, healthResponseSchema, healthContracts } from './index.js';
import { canStaff, staffRoles } from '../permissions.js';

const now = '2026-10-21T20:00:00Z';
const details = {
  last_backup: { latestRestorableAt: now, ageSeconds: 20, overdue: false, retainedBytes: 100,
    retentionBudgetBytes: 1000, pruningStopped: false, keyReminder: true },
  failed_jobs: { failed: 0, pending: 2, running: 1, oldestFailureAt: null },
  smtp: { configured: true, lastTestAt: now },
  disk: { totalBytes: 1000, availableBytes: 800 },
  version: { version: '0.1.0', sourceUrl: 'https://example.com/source' },
  stripe_webhooks: { lastReceivedAt: now, lastProcessedAt: now, pending: 0, failed: 0 },
  last_charge_run: { lastStartedAt: now, lastCompletedAt: now, result: 'succeeded', invoicesProcessed: 1, failures: 0 },
  automatic_updates: { enabled: true, lastAttemptAt: now, result: 'rolled_back', fromVersion: '0.1.0', toVersion: '0.1.1' },
  update_available: { currentVersion: '0.1.0', latestVersion: '0.2.0', available: true, releaseUrl: 'https://example.com/release' },
};
const tiles = healthTileIds.map((id) => ({ id, status: 'healthy', checkedAt: now, message: 'Status checked', details: details[id] }));

describe('health contracts', () => {
  it.each(healthTileIds)('%s supports checked, failed, and not-configured provider states', (id) => {
    for (const status of ['healthy', 'warning', 'error', 'not_configured', 'unavailable']) {
      expect(healthTileSchema.safeParse({ id, status, checkedAt: now, message: 'Status checked', details: details[id] }).success).toBe(true);
    }
    expect(healthTileSchema.safeParse({ id, status: 'not_configured', checkedAt: null, message: 'Not configured', details: null }).success).toBe(true);
    expect(healthTileSchema.safeParse({ id, status: 'healthy', checkedAt: now, message: 'Checked', details: null }).success).toBe(false);
    expect(healthTileSchema.safeParse({ id, status: 'healthy', checkedAt: null, message: 'Checked', details: details[id] }).success).toBe(false);
  });
  it('requires all nine tiles exactly once and accepts initial placeholders for unconfigured providers', () => {
    expect(healthResponseSchema.parse({ data: { generatedAt: now, tiles } }).data.tiles).toHaveLength(9);
    const placeholders = healthTileIds.map((id) => ({ id, status: 'not_configured', checkedAt: null, message: 'Not configured', details: null }));
    expect(healthResponseSchema.parse({ data: { generatedAt: now, tiles: placeholders } }).data.tiles).toHaveLength(9);
    expect(healthResponseSchema.safeParse({ data: { generatedAt: now, tiles: tiles.slice(1) } }).success).toBe(false);
    expect(healthResponseSchema.safeParse({ data: { generatedAt: now, tiles: [...tiles.slice(1), tiles[1]] } }).success).toBe(false);
  });
  it('rejects details for the wrong provider, impossible disk statistics, or secret configuration', () => {
    expect(healthTileSchema.safeParse({ ...tiles[0], details: details.smtp }).success).toBe(false);
    expect(healthTileSchema.safeParse({ ...tiles[3], details: { totalBytes: 100, availableBytes: 101 } }).success).toBe(false);
    expect(healthTileSchema.safeParse({ ...tiles[1], details: { ...details.failed_jobs, failed: -1 } }).success).toBe(false);
    expect(healthTileSchema.safeParse({ ...tiles[2], details: { ...details.smtp, password: 'hidden' } }).success).toBe(false);
    expect(healthTileSchema.safeParse({ ...tiles[5], details: { ...details.stripe_webhooks, payload: {} } }).success).toBe(false);
  });
  it('limits the system health page to managers', () => {
    for (const role of staffRoles) expect(canStaff([role], healthContracts.get.permission.capability)).toBe(['owner', 'admin'].includes(role));
  });
});

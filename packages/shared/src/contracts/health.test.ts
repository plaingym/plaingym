// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { healthTileIds, healthTileSchema, healthResponseSchema, healthContracts, chargeFailureReportSchema, chargeFailuresResponseSchema,
  dismissChargeFailuresRequestSchema, dismissChargeFailuresResponseSchema, maxDismissedChargeRuns, autoUpdateContracts,
  autoUpdateSettingsResponseSchema, updateAutoUpdateSettingsRequestSchema } from './index.js';
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
  it('limits the charge failure reports and their dismissal to managers, like the page that shows them', () => {
    for (const contract of [healthContracts.listChargeFailures, healthContracts.dismissChargeFailures]) {
      expect(contract.permission).toEqual(healthContracts.get.permission);
      for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe(['owner', 'admin'].includes(role));
    }
  });
  it('accepts a dismissal of one run or of the named runs, and refuses one that names none', () => {
    const runId = '0198a000-0000-7000-8000-000000000001', other = '0198a000-0000-7000-8000-000000000002';
    expect(dismissChargeFailuresRequestSchema.parse({ runId })).toEqual({ runId });
    expect(dismissChargeFailuresRequestSchema.parse({ runIds: [runId, other] })).toEqual({ runIds: [runId, other] });
    const tooMany = Array.from({ length: maxDismissedChargeRuns + 1 }, (_, n) => `0198a000-0000-7000-8000-${String(n).padStart(12, '0')}`);
    // An empty body used to dismiss every report, including ones written after the list loaded.
    for (const body of [{}, { runIds: [] }, { runId, runIds: [other] }, { runId: 'run-1' }, { runId: null }, { runIds: ['run-1'] },
      { runIds: tooMany }, { runIds: null }, { runId, all: true }, []])
      expect(dismissChargeFailuresRequestSchema.safeParse(body).success).toBe(false);
    expect(dismissChargeFailuresRequestSchema.safeParse({ runIds: tooMany.slice(0, maxDismissedChargeRuns) }).success).toBe(true);
  });
  it('describes a report by run, day and the invoices that still need staff', () => {
    const failure = { invoiceId: '0198a000-0000-7000-8000-000000000002', number: 41, cause: 'needs_reconciliation' };
    const report = { runId: '0198a000-0000-7000-8000-000000000001', day: '2026-10-26', reportedAt: now, failures: [failure] };
    expect(chargeFailuresResponseSchema.safeParse({ data: [report] }).success).toBe(true);
    expect(chargeFailuresResponseSchema.safeParse({ data: [] }).success).toBe(true);
    expect(chargeFailureReportSchema.safeParse({ ...report, failures: [{ ...failure, number: null, cause: 'unexpected' }] }).success).toBe(true);
    // An emptied report is not listed, and a cause or extra field outside the contract is refused.
    for (const bad of [{ ...report, failures: [] }, { ...report, failures: [{ ...failure, cause: 'declined' }] },
      { ...report, failures: [{ ...failure, number: 0 }] }, { ...report, extra: true }, { ...report, day: 'yesterday' }])
      expect(chargeFailureReportSchema.safeParse(bad).success).toBe(false);
    expect(dismissChargeFailuresResponseSchema.safeParse({ data: { dismissed: [failure.invoiceId] } }).success).toBe(true);
  });
  it('reports a skipped automatic update, and keeps the other results', () => {
    for (const result of ['never_run', 'up_to_date', 'updated', 'rolled_back', 'failed', 'skipped'])
      expect(healthTileSchema.safeParse({ ...tiles[7], status: 'warning', details: { ...details.automatic_updates, result } }).success).toBe(true);
    expect(healthTileSchema.safeParse({ ...tiles[7], details: { ...details.automatic_updates, result: 'paused' } }).success).toBe(false);
    expect(healthTileSchema.safeParse({ ...tiles[7], details: { ...details.automatic_updates, reason: 'backups' } }).success).toBe(false);
  });
  it('limits the automatic update switch to owners and needs a revision to change it', () => {
    for (const contract of [autoUpdateContracts.get, autoUpdateContracts.update])
      for (const role of staffRoles) expect(canStaff([role], contract.permission.capability)).toBe(role === 'owner');
    expect(updateAutoUpdateSettingsRequestSchema.parse({ enabled: false, revision: 3 })).toEqual({ enabled: false, revision: 3 });
    for (const body of [{ enabled: false }, { enabled: 'no', revision: 3 }, { enabled: true, revision: 0 }, { enabled: true, revision: 3, available: true }])
      expect(updateAutoUpdateSettingsRequestSchema.safeParse(body).success).toBe(false);
    expect(autoUpdateSettingsResponseSchema.safeParse({ data: { enabled: true, available: false, revision: 1 } }).success).toBe(true);
  });
});

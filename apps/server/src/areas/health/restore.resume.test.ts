// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '../../core/log.js';
import { decryptSecret } from '../../core/secrets.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ shared: true });
let base: string;
beforeAll(async () => { base = (await f.prepare(() => f.backup().snapshot())).id; });

describe('install restore after an interruption', () => {
  it('reports postponed staging cleanup while the backup lock is held and sweeps on retry', async () => {
    const service = f.restore(), staging = service.options.stagingDirectory;
    const abandoned = join(staging, 'restore-abandoned');
    await mkdir(abandoned, { recursive: true });
    const plaintext = join(abandoned, 'plaintext');
    await writeFile(plaintext, 'staged snapshot');
    const lines: string[] = [], previous = setLogSink(line => lines.push(line));
    try {
      let resumed: ReturnType<typeof service.resume> | undefined, settled = false;
      try {
        await f.targetMaintenance.locked(async () => {
          resumed = service.resume().finally(() => { settled = true; });
          void resumed.catch(() => {}); // Observe failures while waiting for completion under the lock.
          await vi.waitFor(() => { expect(settled).toBe(true); }, { timeout: 2_000 });
          expect(await resumed).toBe('staging_sweep_skipped');
          expect(await readdir(staging)).toEqual(['restore-abandoned']);
          expect(await readFile(plaintext, 'utf8')).toBe('staged snapshot');
          expect(await service.options.gate.isClosed()).toBe(false);
          expect(lines.map(line => JSON.parse(line))).toEqual([{
            time: expect.any(String), level: 'info', event: 'restore.staging_sweep_skipped', reason: 'backup_lock_busy',
          }]);
        });
      } finally { await resumed; }
      lines.length = 0;
      expect(await service.resume()).toBeUndefined();
      expect(await readdir(staging)).toEqual([]);
      expect(lines).toEqual([]);
    } finally { setLogSink(previous); }
  });
  it.each(['database_restored', 'secret_field', 'rekeyed', 'old_uploads_renamed', 'new_uploads_renamed', 'billing_reconciliation_queued'] as const)(
    'resumes after interruption at %s', async (stop) => {
      let interrupted = false;
      const service = f.restore((phase) => { if (!interrupted && phase === stop) { interrupted = true; throw new Error('Power loss'); } });
      await expect(service.restore(base, f.identity)).rejects.toThrow('The staged restore failed; preserve the restore state and check the server before retrying resume');
      expect(interrupted).toBe(true);
      expect(await f.gate().isClosed()).toBe(true);
      expect(await f.restore().resume()).toBeUndefined();
      const { gym } = await f.secretRows();
      expect(decryptSecret(f.currentKey, f.context('qr_key'), gym.qrKey!)).toBe('stable-qr-secret');
      expect(gym.billingEnabled).toBe(false);
      await f.restore().resume(); // Complete journals are harmless on every subsequent boot.
      expect(await f.gate().isClosed()).toBe(false);
      const queue = new PostgresJobs({ database: f.target, clock: f.clock }), queued = vi.fn(async () => {});
      queue.handle('billing.runner.restore', queued);
      expect(await queue.runNext()).toBe(true); expect(await queue.runNext()).toBe(false);
      expect(queued).toHaveBeenCalledOnce();
    });
  it('blames a journal it cannot read on the journal, not on the snapshot', async () => {
    const { statePath } = f.gate(), previous = await readFile(statePath, 'utf8').catch(() => null);
    await writeFile(statePath, JSON.stringify({ phase: 'verified' }));
    try {
      await expect(f.restore().resume()).rejects.toMatchObject({ name: 'RestoreFailure',
        message: 'The restore journal is not in a format this version reads' });
    } finally {
      if (previous === null) await rm(statePath, { force: true });
      else await writeFile(statePath, previous);
    }
  });
});

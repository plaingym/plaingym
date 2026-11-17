// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Restore regression inspects the production queue's stored outcome.
import { jobs } from '@plaingym/db';
import type { FakePayments } from '../../infra/payments/index.js';
import { restoredBilling as billing } from './restore.billing.test-helper.js';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ shared: true });
let base: string;
beforeAll(async () => { base = (await f.prepare(() => f.backup().snapshot())).id; });
const restored = () => billing(f);

describe('restored billing through production restore, jobs and go-live routes', () => {
  it.each([false, true])('succeeds the queued check while a long rerun holds its lease (legacy payload: %s)', async legacy => {
    await f.restore().restore(base, f.identity);
    const b = await restored();
    const queued = (await f.target.forGym(f.gymId, tx => tx.select().from(jobs).where(eq(jobs.name, 'billing.runner.restore'))))[0]!;
    if (legacy) {
      const snapshotAt = (await b.read()).restoreReconciliation!.snapshotAt;
      await f.target.forGym(f.gymId, tx => tx.update(jobs).set({ payload: { version: 1, timezone: 'UTC',
        value: { snapshotAt } } }).where(eq(jobs.id, queued.id)));
    }
    let entered!: () => void, release!: (value: Awaited<ReturnType<FakePayments['listChangesSince']>>) => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const list = vi.spyOn(b.provider, 'listChangesSince').mockImplementationOnce(async () => {
      entered(); return new Promise(resolve => { release = resolve; });
    });
    const running = b.rerun();
    try {
      await began;
      // Keep the rerun active beyond every retry's backoff in the production Postgres queue.
      for (let attempt = 0; attempt < queued.maxAttempts; attempt++) {
        await b.queue.runNext();
        f.clock.advance(60_000);
      }
      const [finished] = await f.target.forGym(f.gymId, tx => tx.select().from(jobs).where(eq(jobs.id, queued.id)));
      expect(finished).toMatchObject({ status: 'succeeded', attempts: 1, lastError: null });
      expect(list).toHaveBeenCalledOnce();
    } finally {
      release({ changes: [], nextCursor: null });
      try { expect((await running).status).toBe(200); } finally { list.mockRestore(); }
    }
    expect((await b.read()).restoreReconciliation).toMatchObject({ unresolved: 0, checkedAt: expect.any(String) });
  });
  it('invalidates old results on a newer restore and ignores delayed old jobs', async () => {
    await f.restore().restore(base, f.identity);
    const b = await restored(); await b.queue.runNext();
    const old = (await b.read()).restoreReconciliation!;
    // Snapshot a reconciled install so the second restore actually contains the earlier success.
    const next = await f.backup({ database: f.targetMaintenance, scope: f.target, appEncryptionKey: f.currentKey }).snapshot();
    await f.restore().restore(next.id, f.identity);
    const current = (await b.read()).restoreReconciliation!;
    expect(current.restoreId).not.toBe(old.restoreId); expect(current.checkedAt).toBeNull();
    expect((await b.enable()).status).toBe(409);
    await b.runner.postRestore(f.gymId, new Date(old.snapshotAt!), old.restoreId);
    expect((await b.read()).restoreReconciliation!.checkedAt).toBeNull();
    await b.queue.runNext();
    expect((await b.enable()).status).toBe(200);
  });
  it('blocks on the newest failed or interrupted check and permits a later rerun', async () => {
    await f.restore().restore(base, f.identity);
    const b = await restored(); await b.queue.runNext();
    const list = vi.spyOn(b.provider, 'listChangesSince').mockRejectedValueOnce(new Error('Provider unavailable'));
    expect((await b.rerun()).status).toBe(503);
    expect((await b.read()).restoreReconciliation!.unresolved).toBe(1);
    expect((await b.enable()).status).toBe(409);
    list.mockRestore();
    expect((await b.rerun()).status).toBe(200);
    expect((await b.enable()).status).toBe(200);
  });
  it('refuses a rerun while an earlier check is in flight, then lets a failed rerun block and a later one clear', async () => {
    await f.restore().restore(base, f.identity);
    const b = await restored(); await b.queue.runNext();
    let entered!: () => void, release!: (value: Awaited<ReturnType<FakePayments['listChangesSince']>>) => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const list = vi.spyOn(b.provider, 'listChangesSince').mockImplementationOnce(async () => {
      entered(); return new Promise(resolve => { release = resolve; });
    }).mockRejectedValueOnce(new Error('Provider unavailable'));
    const running = b.rerun();
    try {
      await began;
      expect((await b.enable()).status).toBe(409);
      // A second check would run beside the first, which could then finish over it: it waits for the first's result.
      const overlapping = await b.rerun();
      expect(overlapping.status).toBe(409);
      expect(await overlapping.json()).toMatchObject({ error: { details: { restoreId: ['check_running'] } } });
    } finally { release({ changes: [], nextCursor: null }); expect((await running).status).toBe(200); }
    expect((await b.read()).restoreReconciliation!.unresolved).toBe(0);
    // The next rerun runs, and its failure blocks billing until a later one clears it.
    expect((await b.rerun()).status).toBe(503);
    list.mockRestore();
    expect((await b.read()).restoreReconciliation!.unresolved).toBe(1);
    expect((await b.enable()).status).toBe(409);
    expect((await b.rerun()).status).toBe(200);
    expect((await b.enable()).status).toBe(200);
  });
});

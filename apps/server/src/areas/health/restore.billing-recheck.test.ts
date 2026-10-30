// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FakePayments } from '../../infra/payments/index.js';
import { restoredBilling as billing } from './restore.billing.test-helper.js';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() }, { shared: true });
let base: string;
beforeAll(async () => { base = (await f.prepare(() => f.backup().snapshot())).id; });
const restored = () => billing(f);

describe('restored billing through production restore, jobs and go-live routes', () => {
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
  it('keeps a newer failed check blocked when an earlier in-flight check later succeeds', async () => {
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
      expect((await b.rerun()).status).toBe(503);
    } finally { release({ changes: [], nextCursor: null }); await running; list.mockRestore(); }
    expect((await b.read()).restoreReconciliation!.unresolved).toBe(1);
    expect((await b.enable()).status).toBe(409);
    expect((await b.rerun()).status).toBe(200);
    expect((await b.enable()).status).toBe(200);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { generateIdentity, identityToRecipient } from '../../../infra/age/index.js';
import { FakeBackupObjectStore } from '../../../infra/storage/index.js';
import { BackupService } from '../../health/backups.js';
import { PostgresMaintenance, type ToolRunner } from '../../health/backups.database.js';
import { RestoreService } from '../../health/restore.js';
import { RestoreGate } from '../../health/restore.gate.js';
import { workflowFixture } from './workflow-fixture.js';

const db = useTestDatabase();
// Real pg_dump/pg_restore, with disposable, named clients and no host PostgreSQL prerequisite.
const dockerTools: ToolRunner = (tool, env) => ({ command: 'docker', args: ['run', '--rm', '-i',
  '--name', `plaingym-billing-restore-${tool}-${randomBytes(6).toString('hex')}`, '--cpus', '1',
  ...(process.platform === 'linux' ? ['--network', 'host'] : []), '-e', 'PGHOST', '-e', 'PGPORT', '-e', 'PGDATABASE',
  '-e', 'PGUSER', '-e', 'PGPASSWORD', '-e', 'PGCONNECT_TIMEOUT',
  'postgres:18@sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32',
  'timeout', '60', 'nice', '-n', '10', tool], env: { ...env, PGHOST: process.platform === 'linux' ? '127.0.0.1' : 'host.docker.internal' } });

it('restores an older encrypted backup and reconciles subsequent charge, refund and dispute while billing remains off', async () => {
  const f = await workflowFixture(db), root = await mkdtemp(join(tmpdir(), 'plaingym-billing-restore-'));
  const database = new PostgresMaintenance(db.maintenanceUrl, dockerTools), store = new FakeBackupObjectStore(f.clock);
  const identity = await generateIdentity(), key = randomBytes(32);
  const backup = new BackupService({ database, store, clock: f.clock, scope: db,
    recipient: await identityToRecipient(identity), blobKey: randomBytes(32), appEncryptionKey: key,
    stagingDirectory: join(root, 'backup'), uploads: async () => new Map() });
  let snapshot: Awaited<ReturnType<BackupService['snapshot']>> | undefined;
  const confirm = f.provider.confirmCharge.bind(f.provider);
  vi.spyOn(f.provider, 'confirmCharge').mockImplementationOnce(async (id, options) => {
    // Snapshot contains the real runner's pending attempt and saved intent, before money moves.
    snapshot = await backup.snapshot();
    return confirm(id, options);
  });
  try {
    expect((await f.runner.daily(f.gymId)).errors).toEqual([]); await f.drain();
    const paid = (await f.read()).payments[0]!;
    const refund = await f.provider.refund({ chargeId: paid.paymentIntentId!, amount: 2500, idempotencyKey: 'external-refund' });
    f.transport.objects.get(refund.id)!.metadata = {};
    f.transport.objects.set('dp_after_backup', { id: 'dp_after_backup', object: 'dispute', charge: paid.chargeId,
      amount: 10000, currency: 'usd', status: 'needs_response', metadata: {}, created: f.transport.now });
    f.clock.advance(2 * 86400000);
    const restore = new RestoreService({ database, store, clock: f.clock, appEncryptionKey: randomBytes(32),
      stagingDirectory: join(root, 'restored', 'staging'), uploadsDirectory: join(root, 'restored', 'uploads'),
      gate: new RestoreGate(join(root, 'restored')) });
    await restore.restore(snapshot!.id, identity);
    expect((await f.settings.get(f.gymId)).billingEnabled).toBe(false);
    expect((await f.read()).payments).toEqual([]); expect((await f.read()).refunds).toEqual([]);
    const create = vi.spyOn(f.provider, 'createCharge');
    // RestoreService itself queues the real restore-reconciliation job.
    await f.drain();
    const state = await f.read();
    expect(state.payments).toHaveLength(1); expect(state.refunds).toMatchObject([{ processorId: refund.id, status: 'succeeded', amountCents: 2500 }]);
    expect(state.invoices[0]).toMatchObject({ status: 'partially_refunded', disputeId: 'dp_after_backup', disputeStatus: 'open' });
    expect(state.audits.filter(a => a.action === 'billing.runner.restore_checked')).toMatchObject([{ after: { unresolved: 0 } }]);
    await f.runJob('billing.runner.restore', { snapshotAt: snapshot!.startedAt });
    await f.runJob('billing.runner.daily');
    expect(create).not.toHaveBeenCalled(); expect((await f.read()).payments).toHaveLength(1); expect((await f.read()).refunds).toHaveLength(1);
    expect((await f.settings.get(f.gymId)).billingEnabled).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { BackupService } from './backups.js';
import { PostgresMaintenance } from './backups.database.js';
import { createBackupControl } from './restore.backup-control.js';
import { useRestoreFixture, dockerTools } from './restore.fixture.test-helper.js';
import { restoredBilling } from './restore.billing.test-helper.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';

const f = useRestoreFixture({ shared: true });
let snapshotId: string;
beforeAll(async () => {
  snapshotId = (await f.prepare(async () => {
    await f.source.forGym(f.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled: true,
      settings: { kept: true, manualBackup: { requestId: uuidv7(), status: 'running',
        requestedAt: f.clock.now().toISOString(), completedAt: null, snapshotId: null } } }).where(eq(gyms.id, f.gymId)));
    return f.backup().snapshot();
  })).id;
});
describe('restore follow-up safety', () => {
  it('turns member emails off with billing, clears old jobs, and Go live explicitly enables emails again', async () => {
    await f.restore().restore(snapshotId, f.identity);
    const { gym } = await f.secretRows();
    expect(gym).toMatchObject({ billingEnabled: false, memberEmailsEnabled: false,
      settings: { backupPruningHeld: true, kept: true } });
    expect(gym.settings).not.toHaveProperty('manualBackup');
    const b = await restoredBilling(f);
    expect((await b.request('/api/settings/go-live', 'PATCH', { revision: (await b.read()).revision, memberEmailsEnabled: true })).status).toBe(200);
    expect(await b.read()).toMatchObject({ memberEmailsEnabled: true, billingEnabled: false });
  });
  it('preserves every bucket object during snapshots and pruning until an audited owner release', async () => {
    await f.restore().restore(snapshotId, f.identity);
    const database = new PostgresMaintenance(f.target.maintenanceUrl, dockerTools);
    const backup = new BackupService({ ...f.backup().options, database, appEncryptionKey: f.currentKey,
      scope: f.target, uploads: async () => new Map([[f.gymId, f.restoredUploads()]]) });
    // An orphan normally collected by prune, alongside the complete restored snapshot.
    const orphan = 'blobs/' + 'e'.repeat(64) + '.age';
    await f.store.putObject(orphan, new Blob(['orphan']).stream());
    const before = new Map([...f.server.objects].map(([key, value]) => [key, Buffer.from(value.bytes)]));
    expect(await database.pruningHeld()).toBe(true);
    await expect(backup.prune()).rejects.toThrow('Restore pruning hold');
    await backup.snapshot('manual');
    for (const [key, bytes] of before) expect(f.server.objects.get(key)?.bytes).toEqual(bytes);
    const user = await createFactories(f.target)('authUser', f.gymId);
    const control = createBackupControl({ scope: f.target.forGym, queue: new PostgresJobs({ database: f.target, clock: f.clock }),
      clock: f.clock, available: () => true, configuredGym: async () => f.gymId });
    const state = await control.get(f.gymId);
    await control.confirm({ gymId: f.gymId, userId: user.id }, state.revision);
    expect(await database.pruningHeld()).toBe(false);
    await backup.prune();
    expect(f.server.objects.has('backups/' + orphan)).toBe(false);
  });
});

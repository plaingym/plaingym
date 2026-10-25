// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { exportRuns, forGym, importChunks, importRuns, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportRetention, EXPORT_STALE_MS, RUN_RETENTION_MS, UPLOAD_RETENTION_MS } from './retention.js';

const database = useTestDatabase(), factory = createFactories(database);
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const clock = new TestClock('2099-10-24T00:00:00Z'), storage = new FakeUploads(gymId, clock);
  const options = { clock, uploadsFor: async () => storage, scope: database.forGym };
  return { gymId, clock, storage, options, service: createImportRetention(options) };
}

it.each(['pending', 'running'] as const)('recovers stale %s table runs, preserving fresh runs, progress and other gyms', async (status) => {
  const { gymId, clock, service } = await fixture(), now = clock.now();
  const importCutoff = new Date(now.getTime() - UPLOAD_RETENTION_MS), exportCutoff = new Date(now.getTime() - EXPORT_STALE_MS);
  const staleImport = await factory('importRuns', gymId, { status, createdAt: importCutoff, updatedAt: now,
    totalRows: 2, processedRows: 1, committedRows: 1 });
  const chunk = await factory('importChunks', gymId, { runId: staleImport.id, rowCount: 1, committedRows: 1, completedAt: importCutoff });
  const staleExport = await factory('exportRuns', gymId, { status, createdAt: exportCutoff, updatedAt: exportCutoff });
  const freshImport = await factory('importRuns', gymId, { status, createdAt: new Date(importCutoff.getTime() + 1), updatedAt: now });
  const freshExport = await factory('exportRuns', gymId, { status, createdAt: exportCutoff, updatedAt: new Date(exportCutoff.getTime() + 1) });
  const otherGym = uuidv7(); await factory('gyms', otherGym);
  const otherImport = await factory('importRuns', otherGym, { status, createdAt: importCutoff, updatedAt: importCutoff });
  const otherExport = await factory('exportRuns', otherGym, { status, createdAt: exportCutoff, updatedAt: exportCutoff });
  expect(await service.expire(gymId)).toBe(0);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importRuns).where(eq(importRuns.id, staleImport.id))))
    .toMatchObject([{ status: 'failed', completedAt: now, updatedAt: now, processedRows: 1, committedRows: 1, errorCount: 0 }]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, staleExport.id))))
    .toMatchObject([{ status: 'failed', completedAt: now, updatedAt: now, downloadUrl: null, expiresAt: null }]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importChunks).where(eq(importChunks.id, chunk.id)))).toEqual([chunk]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(importRuns).where(eq(importRuns.id, freshImport.id)))).toEqual([freshImport]);
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, freshExport.id)))).toEqual([freshExport]);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(importRuns))).toEqual([otherImport]);
  expect(await database.forGym(otherGym, (tx) => tx.select().from(exportRuns))).toEqual([otherExport]);
  clock.advance(60_000); await service.expire(gymId);
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, staleExport.id))))
    .toMatchObject([{ completedAt: now, updatedAt: now }]);
});

it.each(['import', 'export'] as const)('does not overwrite a %s finisher that holds the run lock when recovery races it', async (kind) => {
  const { gymId, clock, options } = await fixture(), now = clock.now();
  const stale = new Date(now.getTime() - EXPORT_STALE_MS);
  const table = kind === 'import' ? importRuns : exportRuns;
  const run = kind === 'import'
    ? await factory('importRuns', gymId, { status: 'running', createdAt: stale, updatedAt: stale })
    : await factory('exportRuns', gymId, { status: 'running', createdAt: stale, updatedAt: stale });
  const locked = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const finishing = database.forGym(gymId, async (tx) => {
    await tx.select({ id: table.id }).from(table).where(eq(table.id, run.id)).for('update');
    locked.resolve(); await release.promise;
    if (kind === 'import') await tx.update(importRuns).set({ status: 'succeeded', processedRows: 1, committedRows: 1,
      completedAt: now, updatedAt: now }).where(eq(importRuns.id, run.id));
    else await tx.update(exportRuns).set({ status: 'succeeded', completedAt: now, updatedAt: now,
      downloadUrl: 'https://uploads.invalid/finished.zip', expiresAt: new Date(now.getTime() + 3600_000) }).where(eq(exportRuns.id, run.id));
  });
  let sweeping: Promise<number> | undefined;
  try {
    await locked.promise;
    const scope: typeof forGym = (gym, fn) => database.forGym(gym, (tx) => { entered.resolve(); return fn(tx); });
    sweeping = createImportRetention({ ...options, scope }).expire(gymId);
    await entered.promise; release.resolve();
    await Promise.all([finishing, sweeping]);
    expect(await database.forGym(gymId, (tx) => tx.select({ status: table.status, completedAt: table.completedAt }).from(table)
      .where(eq(table.id, run.id)))).toEqual([{ status: 'succeeded', completedAt: now }]);
  } finally {
    release.resolve(); await Promise.allSettled([finishing, ...(sweeping ? [sweeping] : [])]);
  }
});

it('keeps a fresh export row and its older archive together when the indexed retention scan omits the row', async () => {
  const { gymId, clock, storage, service } = await fixture();
  const run = await factory('exportRuns', gymId, { status: 'succeeded', createdAt: clock.now(), updatedAt: clock.now(),
    completedAt: clock.now(), downloadUrl: 'https://uploads.invalid/archive.zip', expiresAt: new Date(clock.now().getTime() + RUN_RETENTION_MS * 2) });
  const key = `${gymId}/imports/exports/${run.id}/export.zip`;
  await storage.put(key, new Uint8Array([1]), 'application/zip');
  clock.advance(RUN_RETENTION_MS);
  const [fresh] = await database.forGym(gymId, (tx) => tx.update(exportRuns).set({ updatedAt: clock.now() })
    .where(eq(exportRuns.id, run.id)).returning());
  expect(await service.expire(gymId)).toBe(0);
  expect((await storage.head(key))?.deletedAt).toBeUndefined();
  expect(await database.forGym(gymId, (tx) => tx.select().from(exportRuns).where(eq(exportRuns.id, run.id)))).toEqual([fresh]);
  expect(await storage.sweep({ before: clock.now() })).toEqual([]);
});

it('leaves unfinished legacy manifests alone when they pass the table recovery deadlines', async () => {
  const { gymId, clock, storage, service } = await fixture();
  const legacy = { status: 'running' }, bytes = new TextEncoder().encode(JSON.stringify(legacy));
  const keys = [`${gymId}/imports/runs/${uuidv7()}/run.json`, `${gymId}/imports/exports/${uuidv7()}/running.json`];
  for (const key of keys) await storage.put(key, bytes, 'application/json');
  clock.advance(EXPORT_STALE_MS + 1);
  expect(await service.expire(gymId)).toBe(0);
  for (const key of keys) {
    expect((await storage.head(key))?.deletedAt).toBeUndefined();
    expect(await new Response(await storage.get(key)).json()).toEqual(legacy);
  }
});

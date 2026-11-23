// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeUploads, type Uploads } from '../../infra/storage/index.js';
import { createAdmissionCleanup } from './admission.cleanup.js';

const db = useTestDatabase(), factory = createFactories(db);

async function fixture(uploadsFor: (gymId: string) => Promise<Uploads>, candidates: number) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-02T12:00:00Z');
  await factory('gyms', gymId);
  const ids = Array.from({ length: candidates }, () => uuidv7());
  await db.forGym(gymId, async tx => {
    for (const id of ids) await writeAudit(tx, { gymId, actorKind: 'system', action: 'public.drop_in.admitted', targetType: 'member', targetId: id, occurredAt: clock.now() });
  });
  const cleanup = createAdmissionCleanup({ scope: db.forGym, clock, uploadsFor, prefix: 'public.drop_in', targetType: 'member', excluded: [],
    lock: async () => undefined, memberIds: admission => [admission.targetId], claim: async () => true });
  const cleaned = async () => (await db.forGym(gymId, tx => tx.select({ id: auditEvents.targetId }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'public.drop_in.cleaned'))))).map(row => row.id);
  return { gymId, ids, cleanup, cleaned };
}

it('resolves storage again for the next candidate after a failed resolution', async () => {
  const outage = new Error('storage unavailable');
  const uploadsFor = vi.fn<(gymId: string) => Promise<Uploads>>()
    .mockRejectedValueOnce(outage).mockImplementation(async gymId => new FakeUploads(gymId));
  const f = await fixture(uploadsFor, 2), uploads = f.cleanup.uploadsForRun(f.gymId);
  await expect(f.cleanup.remove(f.gymId, f.ids[0]!, uploads)).rejects.toBe(outage);
  await expect(f.cleanup.remove(f.gymId, f.ids[1]!, uploads)).resolves.toBe(true);
  expect(uploadsFor).toHaveBeenCalledTimes(2);
  expect(await f.cleaned()).toEqual([f.ids[1]]);
});

it('resolves storage once for every candidate of a run', async () => {
  const uploadsFor = vi.fn(async (gymId: string): Promise<Uploads> => new FakeUploads(gymId));
  const f = await fixture(uploadsFor, 3), uploads = f.cleanup.uploadsForRun(f.gymId);
  for (const id of f.ids) await expect(f.cleanup.remove(f.gymId, id, uploads)).resolves.toBe(true);
  expect(uploadsFor).toHaveBeenCalledTimes(1);
  expect((await f.cleaned()).sort()).toEqual([...f.ids].sort());
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { uuidv7 } from '@plaingym/db';
import { TestClock } from '../../core/clock.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { readSnapshot } from '../../areas/waivers/snapshot.js';
import { waiversSeed } from './waivers.js';
import { membersSeed } from './members.js';
const db = useTestDatabase(), factory = createFactories(db);
it('seeds signed and unsigned members, including a guardian, with retries and isolation', async () => {
  const gymId = uuidv7(), other = uuidv7(); await factory('gyms', gymId); await factory('gyms', other);
  const clock = new TestClock('2026-10-24T12:00:00Z'), uploads = new FakeUploads(gymId, clock);
  const options = { scope: db.forGym, clock, uploadsFor: async () => uploads };
  const context = { gymId, timezone: 'America/Vancouver', enabledModules: new Set<string>() };
  await membersSeed({ scope: db.forGym, clock, pinSecret: null }).run(context);
  const step = waiversSeed(options); await step.run(context); await step.run(context);
  const service = createWaiversService(options), signatures = await service.listSignatures(gymId);
  expect(signatures.pagination.total).toBe(3);
  expect((await service.listTemplates(gymId)).pagination.total).toBe(1);
  expect((await service.listSignatures(other)).data).toEqual([]);
  expect((await service.listTemplates(other)).data).toEqual([]);
  const snapshots = signatures.data.map(r => readSnapshot(r.snapshot, r.snapshotHash));
  expect(snapshots.find(s => s.member.firstName === 'Ava')?.signer).toEqual({ kind: 'guardian', name: 'Daniel Chen', relationship: 'Parent' });
  expect((await uploads.list()).filter(r => r.contentType === 'image/png')).toHaveLength(3);
}, 60_000);

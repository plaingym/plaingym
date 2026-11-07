// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, waiverTemplates } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import { createSeedCommand } from './seed-cli.js';
import { useUnconfiguredSandbox } from './seed/portal.fixture.test-helper.js';

const { db, fixture } = useUnconfiguredSandbox();

it('checks the sandbox join service after adding the key and after its owner turns billing off', async () => {
  const { gymId } = db.seeded, f = fixture(true);
  // The install has a key now, but this sandbox was seeded without one and still has billing off.
  await expect(f.join.ready(gymId)).rejects.toMatchObject({ code: 'unavailable' });
  expect((await f.service.status(gymId)).join).toBe(false);
  expect(await createSeedCommand(db.forGym, f.seed).run([gymId], { stdout: vi.fn(), stderr: vi.fn() })).toBe(0);
  expect((await f.join.ready(gymId)).length).toBeGreaterThan(0);
  expect((await f.service.status(gymId)).join).toBe(true);
  await db.forGym(gymId, tx => tx.update(gyms).set({ billingEnabled: false }).where(eq(gyms.id, gymId)));
  await expect(f.join.ready(gymId)).rejects.toMatchObject({ code: 'unavailable' });
  expect((await f.service.status(gymId)).join).toBe(false);
}, 90_000);

it('uses payment and current-waiver readiness, not just the billing switch', async () => {
  const { gymId } = db.seeded;
  await db.forGym(gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, gymId)));
  expect((await fixture(false).service.status(gymId)).join).toBe(false);
  const keyed = fixture(true);
  expect((await keyed.service.status(gymId)).join).toBe(true);
  await db.forGym(gymId, tx => tx.update(waiverTemplates).set({ retiredAt: keyed.clock.now() }));
  await expect(keyed.join.ready(gymId)).rejects.toMatchObject({ code: 'unavailable' });
  expect((await keyed.service.status(gymId)).join).toBe(false);
});

it('propagates readiness errors other than joining being unavailable', async () => {
  const { gymId } = db.seeded, f = fixture(true), error = new AppError('internal', 'Read failed');
  f.service.setJoinReadiness({ ready: async () => { throw error; } });
  await expect(f.service.status(gymId)).rejects.toBe(error);
});

it('keeps the expiry guard independent of join readiness', async () => {
  const { gymId } = db.seeded, f = fixture(true), ready = vi.fn(async () => { throw new AppError('internal', 'Read failed'); });
  f.service.setJoinReadiness({ ready });
  expect(await f.service.live(gymId)).toEqual({ expiresAt: expect.any(String) });
  expect(ready).not.toHaveBeenCalled();
});

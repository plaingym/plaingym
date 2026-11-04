// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { auditEvents, gyms, uuidv7, RevisionConflictError } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createModuleSettings, readModuleSettings } from './module-settings.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-03T12:00:00Z');
const store = createModuleSettings({ scope: db.forGym, clock });
const system = { kind: 'system' } as const;

it('keeps a module value beside the gym\'s other settings, under the gym revision, and audits each save', async () => {
  const gymId = uuidv7(), other = uuidv7();
  const opaque = { setup: { completed: true }, demo: { sandbox: true, ready: true, expiresAt: '2026-11-04T12:00:00Z' }, modules: { other: { kept: 1 } } };
  await factory('gyms', gymId, { settings: opaque, branding: { logoKey: `${gymId}/logo.png`, primaryColor: '#123456' } });
  await factory('gyms', other);
  expect(await store.get(gymId, 'website')).toEqual({ value: null, branding: { logoKey: `${gymId}/logo.png`, primaryColor: '#123456' }, revision: 1 });

  const saved = await store.save({ gymId, actor: system }, 'website', 1, (current) => ({ value: { about: 'Hello', previous: current.value } }));
  expect(saved).toEqual({ value: { about: 'Hello', previous: null }, branding: { logoKey: `${gymId}/logo.png`, primaryColor: '#123456' }, revision: 2 });
  const [row] = await db.forGym(gymId, (tx) => tx.select({ settings: gyms.settings }).from(gyms).where(eq(gyms.id, gymId)));
  expect(row!.settings).toEqual({ ...opaque, modules: { other: { kept: 1 }, website: { about: 'Hello', previous: null } } });

  const branded = await store.save({ gymId, actor: system }, 'website', 2, ({ value }) => ({ value, branding: { logoKey: null } }));
  expect(branded.branding).toEqual({ logoKey: null }); expect(branded.revision).toBe(3);
  await expect(store.save({ gymId, actor: system }, 'website', 2, () => ({ value: 'stale' }))).rejects.toBeInstanceOf(RevisionConflictError);
  await expect(store.save({ gymId, actor: system }, 'website', 3, () => ({ value: 1, branding: { primaryColor: 'red' } }))).rejects.toThrow();
  expect((await store.get(gymId, 'website')).revision).toBe(3);

  const audits = await db.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.module.updated')));
  expect(audits).toHaveLength(2);
  expect(audits[0]).toMatchObject({ targetType: 'gym', targetId: gymId, actorKind: 'system',
    before: { module: 'website', value: null }, after: { module: 'website', value: { about: 'Hello', previous: null } } });
  // Another gym's settings are neither read nor written.
  expect(await store.get(other, 'website')).toEqual({ value: null, branding: {}, revision: 1 });
  // Inside another gym's scope, row-level security hides this gym's row.
  await expect(db.forGym(other, (tx) => readModuleSettings(tx, gymId, 'website'))).rejects.toThrow('Gym not found');
});

it('leaves stored branding it can\'t read untouched by a save that doesn\'t change branding', async () => {
  const gymId = uuidv7(), branding = { logoKey: `${gymId}/logo.png`, primaryColor: '#123456', extra: 'kept' };
  await factory('gyms', gymId, { branding });
  expect((await store.get(gymId, 'website')).branding).toEqual({});
  await store.save({ gymId, actor: system }, 'website', 1, () => ({ value: { about: 'Hello' } }));
  const [row] = await db.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
  expect(row!.branding).toEqual(branding);
});

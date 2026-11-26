// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { auditEvents, gyms, uuidv7, RevisionConflictError } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- A test fixture stores a JSON null, which only a SQL literal can write.
import { eq, sql } from 'drizzle-orm';
import { AppError } from '@plaingym/shared';
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

it('answers a stale save with the revision conflict without running its change', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  await store.save({ gymId, actor: system }, 'website', 1, () => ({ value: { about: 'Current' } }));
  const change = vi.fn((): never => { throw new AppError('not_found', 'x'); });
  await expect(store.save({ gymId, actor: system }, 'website', 1, change)).rejects.toBeInstanceOf(RevisionConflictError);
  expect(change).not.toHaveBeenCalled();
  expect(await store.get(gymId, 'website')).toMatchObject({ value: { about: 'Current' }, revision: 2 });
  const audits = await db.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'settings.module.updated')));
  expect(audits).toHaveLength(1);
  // A current save keeps the error its change throws.
  await expect(store.save({ gymId, actor: system }, 'website', 2, change)).rejects.toMatchObject({ code: 'not_found', message: 'x' });
});

it('leaves stored branding it can\'t read untouched by a save that doesn\'t change branding', async () => {
  const gymId = uuidv7(), branding = { logoKey: `${gymId}/logo.png`, primaryColor: 'red' };
  await factory('gyms', gymId, { branding });
  expect((await store.get(gymId, 'website')).branding).toEqual({ logoKey: `${gymId}/logo.png` });
  await store.save({ gymId, actor: system }, 'website', 1, () => ({ value: { about: 'Hello' } }));
  const [row] = await db.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
  expect(row!.branding).toEqual(branding);
});

it('drops only the unreadable value when a save changes branding, keeping the other stored keys', async () => {
  const gymId = uuidv7(), logoKey = `${gymId}/logo.png`;
  await factory('gyms', gymId, { branding: { logoKey, primaryColor: 'red', newerKey: 'kept' } });
  await store.save({ gymId, actor: system }, 'website', 1,
    (current) => ({ value: 1, branding: { ...current.branding, primaryColor: '#654321' } }));
  const [row] = await db.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId)));
  expect(row!.branding).toEqual({ logoKey, primaryColor: '#654321', newerKey: 'kept' });
});

it.each<{ stored: unknown; read: object }>([
  { stored: { logoKey: '', primaryColor: '#123456' }, read: { primaryColor: '#123456' } },
  // Names every object inherits are ordinary unknown keys.
  { stored: { constructor: 'kept', toString: 'kept' }, read: { constructor: 'kept', toString: 'kept' } },
  { stored: sql`'null'::jsonb`, read: {} },
  { stored: [], read: {} },
  { stored: 'text', read: {} },
])('reads stored branding $stored without failing', async ({ stored, read }) => {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  await db.forGym(gymId, (tx) => tx.update(gyms).set({ branding: stored }).where(eq(gyms.id, gymId)));
  expect((await store.get(gymId, 'website')).branding).toStrictEqual(read);
});

it('keeps branding keys a newer release stored, whether or not a save changes branding', async () => {
  const gymId = uuidv7(), branding = { logoKey: `${gymId}/logo.png`, primaryColor: '#123456', newerKey: 'kept' };
  await factory('gyms', gymId, { branding });
  expect((await store.get(gymId, 'website')).branding).toEqual(branding);
  const stored = async () => (await db.forGym(gymId, (tx) => tx.select({ branding: gyms.branding }).from(gyms).where(eq(gyms.id, gymId))))[0]!.branding;
  await store.save({ gymId, actor: system }, 'website', 1, () => ({ value: 1 }));
  expect(await stored()).toEqual(branding);
  await store.save({ gymId, actor: system }, 'website', 2, (current) => ({ value: 2, branding: { ...current.branding, primaryColor: '#654321' } }));
  expect(await stored()).toEqual({ ...branding, primaryColor: '#654321' });
});

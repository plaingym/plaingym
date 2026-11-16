// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { smsDailyUsage, smsDeliveries, smsOutbox } from './schema/index.js';
import { assertCatalog } from './security/catalog.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const db = useTestDatabase(), make = createFactories(db), a = uuidv7(), b = uuidv7();
beforeAll(async () => { await make('gyms', a); await make('gyms', b); });
it('declares all SMS tables with ENABLE and FORCE and exact gym policies', async () => {
  expect(await assertCatalog(db.app.sql)).toEqual({ tableCount: 72, tenantTableCount: 60 });
});
it.each([['smsDailyUsage', smsDailyUsage], ['smsDeliveries', smsDeliveries], ['smsOutbox', smsOutbox]] as const)('isolates %s for reads and mutations', async (name, table) => {
  const row = await make(name, b), predicate = eq(table.id, row.id);
  expect(await db.forGym(a, tx => tx.select().from(table).where(predicate))).toEqual([]);
  expect(await db.app.db.select().from(table).where(predicate)).toEqual([]);
  expect(await db.forSystem(tx => tx.select().from(table).where(predicate))).toEqual([]);
  expect(await db.forGym(a, tx => tx.update(table).set({ createdAt: new Date(0) }).where(predicate).returning())).toEqual([]);
  expect(await db.forGym(a, tx => tx.delete(table).where(predicate).returning())).toEqual([]);
  await expect(db.forGym(a, tx => tx.insert(table).values({ ...row, id: uuidv7() }))).rejects.toMatchObject({ cause: { code: '42501' } });
});
it.each([
  { phoneE164: '2025550123' }, { smsNoticesConsentSource: 'staff' },
  { smsNoticesConsentAt: new Date() }, { smsNoticesConsentAt: new Date(), smsNoticesConsentSource: 'staff' },
  { phoneE164: '+12025550123', smsNoticesConsentAt: new Date(), smsNoticesConsentSource: 'import' },
])('checks consent pairing, number and source for members and households (%#)', async values => {
  for (const name of ['members', 'households'] as const) await expect(make(name, a, values)).rejects.toMatchObject({ cause: { code: '23514' } });
});
it('rejects staff announcements consent and accepts complete portal consent', async () => {
  const values = { phoneE164: '+12025550123', smsAnnouncementsConsentAt: new Date() };
  await expect(make('members', a, { ...values, smsAnnouncementsConsentSource: 'staff' })).rejects.toMatchObject({ cause: { code: '23514' } });
  await expect(make('members', a, { ...values, smsAnnouncementsConsentSource: 'portal' })).resolves.toMatchObject(values);
});
it('checks cap, counters, identifier keys and attempt state', async () => {
  await expect(make('gyms', uuidv7(), { smsDailyCap: 0 })).rejects.toMatchObject({ cause: { code: '23514' } });
  await expect(make('smsDailyUsage', a, { sent: -1 })).rejects.toMatchObject({ cause: { code: '23514' } });
  for (const values of [{ key: '+12025550123' }, { key: '' }, { attempts: 0 }, { state: 'retry' }])
    await expect(make('smsDeliveries', a, values)).rejects.toMatchObject({ cause: { code: '23514' } });
});

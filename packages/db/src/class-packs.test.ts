// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openConnection, type Connection } from './client.js';
import { uuidv7 } from './id.js';
import { classPacks, classPackTaxRates, classPackSales, classCreditEntries, members } from './schema/index.js';
import { applySecurity } from './security/apply.js';
import { assertCatalog } from './security/catalog.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';

const db = useTestDatabase(), factory = createFactories(db), gymA = uuidv7(), gymB = uuidv7();
const rejected = (code: string) => ({ cause: { code } });
let maintenance: Connection;
beforeAll(async () => { maintenance = openConnection(db.maintenanceUrl, 1); await factory('gyms', gymA); await factory('gyms', gymB); });
afterAll(async () => { await maintenance.close(); });
type Entry = typeof classCreditEntries.$inferInsert;
async function lot(gymId = gymA) {
  const sale = await factory('classPackSales', gymId);
  const grant = await factory('classCreditEntries', gymId, {
    memberId: sale.memberId, kind: 'grant', credits: sale.credits, saleId: sale.id, adjustmentId: null, reason: null,
  });
  return { sale, grant, memberId: sale.memberId };
}

describe('class pack storage boundaries', () => {
  it('declares forced RLS on all four tables and applies reason-only updates idempotently', async () => {
    await applySecurity(maintenance.sql);
    await applySecurity(maintenance.sql);
    expect(await assertCatalog(db.app.sql)).toEqual({ tableCount: 69, tenantTableCount: 57 });
  });
  it.each([
    ['classPacks', classPacks], ['classPackTaxRates', classPackTaxRates],
    ['classPackSales', classPackSales], ['classCreditEntries', classCreditEntries],
  ] as const)('isolates reads and writes for %s', async (name, table) => {
    const row = await factory(name, gymB), where = eq(table.id, row.id);
    expect(await db.forGym(gymB, tx => tx.select().from(table).where(where))).toHaveLength(1);
    expect(await db.forGym(gymA, tx => tx.select().from(table).where(where))).toEqual([]);
    expect(await db.app.db.select().from(table).where(where)).toEqual([]);
    expect(await db.forSystem(tx => tx.select().from(table).where(where))).toEqual([]);
    if (name === 'classCreditEntries') {
      expect(await db.forGym(gymA, tx => tx.update(classCreditEntries).set({ reason: '' }).where(where).returning())).toEqual([]);
      await expect(db.forGym(gymA, tx => tx.delete(table).where(where))).rejects.toMatchObject(rejected('42501'));
    } else {
      expect(await db.forGym(gymA, tx => tx.update(table).set({ createdAt: new Date(0) }).where(where).returning())).toEqual([]);
      expect(await db.forGym(gymA, tx => tx.delete(table).where(where).returning())).toEqual([]);
    }
    await expect(db.forGym(gymA, tx => tx.insert(table).values({ ...row, id: uuidv7() }))).rejects.toMatchObject(rejected('42501'));
    await expect(db.app.db.insert(table).values({ ...row, id: uuidv7() })).rejects.toMatchObject(rejected('42501'));
  });
  it('permits reason redaction alone; no other column can be changed and rows cannot be deleted', async () => {
    const entry = await factory('classCreditEntries', gymA);
    await db.forGym(gymA, tx => tx.update(classCreditEntries).set({ reason: '' }).where(eq(classCreditEntries.id, entry.id)));
    for (const key of Object.keys(getTableColumns(classCreditEntries)) as (keyof typeof entry)[]) {
      if (key === 'reason') continue;
      await expect(db.forGym(gymA, tx => tx.update(classCreditEntries).set({ [key]: entry[key] })
        .where(eq(classCreditEntries.id, entry.id)))).rejects.toMatchObject(rejected('42501'));
    }
    await expect(db.forGym(gymA, tx => tx.delete(classCreditEntries).where(eq(classCreditEntries.id, entry.id))))
      .rejects.toMatchObject(rejected('42501'));
  });
  it('detects a mistakenly broadened reason grant in the catalog', async () => {
    await maintenance.sql`grant update (credits) on class_credit_entries to app`;
    await expect(assertCatalog(db.app.sql)).rejects.toThrow('class_credit_entries.credits: unexpected UPDATE');
    await applySecurity(maintenance.sql);
    await expect(assertCatalog(db.app.sql)).resolves.toHaveProperty('tableCount', 69);
  });
  it('rejects foreign gyms on every relationship and foreign members on ledger lots and sales', async () => {
    const foreign = await lot(gymB), own = await lot();
    const pack = await factory('classPacks', gymB), tax = await factory('taxRates', gymB);
    const cases = [
      () => factory('classPackTaxRates', gymA, { packId: pack.id }),
      () => factory('classPackTaxRates', gymA, { taxRateId: tax.id }),
      () => factory('classPackSales', gymA, { packId: pack.id }),
      () => factory('classPackSales', gymA, { memberId: foreign.memberId }),
      () => factory('classPackSales', gymA, { householdId: foreign.sale.householdId, invoiceId: foreign.sale.invoiceId }),
      () => factory('classCreditEntries', gymA, { memberId: foreign.memberId }),
      () => factory('classCreditEntries', gymA, { memberId: own.memberId, credits: -1, lotId: foreign.grant.id }),
      () => factory('classCreditEntries', gymA, { memberId: own.memberId, kind: 'grant', saleId: foreign.sale.id, adjustmentId: null, reason: null }),
    ];
    for (const create of cases) await expect(create()).rejects.toMatchObject(rejected('23503'));
    const other = await lot();
    await expect(factory('classCreditEntries', gymA, { memberId: own.memberId, credits: -1, lotId: other.grant.id })).rejects.toMatchObject(rejected('23503'));
    await expect(factory('classCreditEntries', gymA, { memberId: own.memberId, kind: 'reverse', credits: -1, lotId: own.grant.id,
      saleId: other.sale.id, adjustmentId: null, reason: null }))
      .rejects.toMatchObject(rejected('23503'));
  });
  it('retains the original invoice household and snapshots while a credit recipient moves', async () => {
    const { sale, grant, memberId } = await lot(), home = await factory('households', gymA);
    await db.forGym(gymA, tx => tx.update(members).set({ householdId: home.id }).where(eq(members.id, memberId)));
    await db.forGym(gymA, tx => tx.update(classPacks).set({ credits: 1, expiryDays: 1 }).where(eq(classPacks.id, sale.packId)));
    const [stored] = await db.forGym(gymA, tx => tx.select().from(classPackSales).where(eq(classPackSales.id, sale.id)));
    expect(stored).toEqual(sale);
    expect((await db.forGym(gymA, tx => tx.select().from(classCreditEntries).where(eq(classCreditEntries.id, grant.id))))[0]?.memberId).toBe(memberId);
    await expect(db.forGym(gymA, tx => tx.update(classPackSales).set({ householdId: home.id }).where(eq(classPackSales.id, sale.id))))
      .rejects.toMatchObject(rejected('23503'));
  });
});

describe('catalog and snapshot constraints', () => {
  it.each([{ credits: 0 }, { credits: 101 }, { expiryDays: 0 }, { expiryDays: 3651 }, { amountCents: -1 }, { revision: 0 }])('rejects invalid pack values (%#)', async overrides => {
      await expect(factory('classPacks', gymA, overrides)).rejects.toMatchObject(rejected('23514'));
    });
  it.each([{ credits: 0 }, { credits: 101 }, { expiryDays: 0 }, { expiryDays: 3651 }])('rejects invalid sold snapshots (%#)', async overrides => {
      await expect(factory('classPackSales', gymA, overrides)).rejects.toMatchObject(rejected('23514'));
    });
  it('accepts catalog boundaries and refuses foreign currency, repeated tax links and a second sale on one invoice', async () => {
    await factory('classPacks', gymA, { credits: 1, expiryDays: 1, amountCents: 0 });
    await factory('classPacks', gymA, { credits: 100, expiryDays: 3650 });
    await expect(factory('classPacks', gymA, { currency: 'EUR' })).rejects.toMatchObject(rejected('23503'));
    const link = await factory('classPackTaxRates', gymA), sale = await factory('classPackSales', gymA);
    await expect(factory('classPackTaxRates', gymA, { packId: link.packId, taxRateId: link.taxRateId })).rejects.toMatchObject(rejected('23505'));
    await expect(factory('classPackSales', gymA, { ...sale, id: uuidv7() })).rejects.toMatchObject(rejected('23505'));
  });
});

describe('credit ledger invariants', () => {
  it.each(['grant', 'use', 'expire', 'reverse-sale', 'reverse-attendance', 'adjust-lot', 'adjust-open'] as const)('enforces %s idempotency without restricting other kinds', async kind => {
      const { sale, grant, memberId } = await lot();
      const base = { memberId, reason: null, adjustmentId: null };
      let data: Partial<Entry>;
      switch (kind) {
        case 'grant': data = { ...base, kind: 'grant', credits: 10, saleId: sale.id }; break;
        case 'use': data = { ...base, kind: 'use', credits: -1, lotId: grant.id, attendanceId: uuidv7() }; break;
        case 'expire': data = { ...base, kind: 'expire', credits: -8, lotId: grant.id }; break;
        case 'reverse-sale': data = { ...base, kind: 'reverse', credits: -8, lotId: grant.id, saleId: sale.id }; break;
        case 'reverse-attendance': data = { ...base, kind: 'reverse', credits: 1, lotId: grant.id, attendanceId: uuidv7() }; break;
        case 'adjust-lot': data = { memberId, kind: 'adjust', credits: -2, lotId: grant.id, adjustmentId: uuidv7(), reason: 'Correction' }; break;
        case 'adjust-open': data = { memberId, kind: 'adjust', credits: 2, adjustmentId: uuidv7(), reason: 'Correction' }; break;
      }
      if (kind !== 'grant') await factory('classCreditEntries', gymA, data);
      await expect(factory('classCreditEntries', gymA, data)).rejects.toMatchObject(rejected('23505'));
      // Different attendances and adjustment commands can still use the same lot.
      await factory('classCreditEntries', gymA, { ...base, kind: 'use', credits: -1, lotId: grant.id, attendanceId: uuidv7() });
      await factory('classCreditEntries', gymA, { memberId, credits: -1, lotId: grant.id });
      // No adjustment ID is required on these legitimate non-adjustment rows.
      await factory('classCreditEntries', gymA, { ...base, kind: 'reverse', credits: 1, lotId: grant.id, attendanceId: uuidv7() });
    });
  it('allows one adjustment command to draw on several lots and keeps unique keys scoped to the gym', async () => {
    const first = await lot(), adjustmentId = uuidv7(), attendanceId = uuidv7();
    const second = await factory('classCreditEntries', gymA, { memberId: first.memberId });
    for (const lotId of [first.grant.id, second.id]) await factory('classCreditEntries', gymA,
      { memberId: first.memberId, credits: -1, lotId, adjustmentId });
    for (const gymId of [gymA, gymB]) {
      const opened = await factory('classCreditEntries', gymId, { adjustmentId });
      await factory('classCreditEntries', gymId, { memberId: opened.memberId, kind: 'use', credits: -1, lotId: opened.id,
        attendanceId, adjustmentId: null, reason: null });
    }
  });
  it.each([
    { kind: 'grant', credits: -1 }, { kind: 'use', credits: -2 }, { kind: 'expire', credits: 1 }, { credits: 0 },
    { kind: 'reverse', credits: 2 }, { kind: 'reverse', credits: -1, saleId: null, attendanceId: 'attendance' },
    { kind: 'adjust', credits: -1, lotId: null }, { kind: 'adjust', credits: 1, lotId: 'lot' },
    { kind: 'adjust', reason: null }, { kind: 'adjust', adjustmentId: null }, { kind: 'adjust', reason: 'x'.repeat(501) },
    { kind: 'use', expiresAt: new Date() }, { kind: 'expire', attendanceId: 'attendance' },
    { kind: 'use', reason: 'Unexpected' }, { kind: 'use', adjustmentId: 'adjustment' }, { kind: 'unknown' },
    { kind: 'grant', saleId: null }, { kind: 'use', attendanceId: null }, { kind: 'reverse', saleId: null, attendanceId: null },
    { kind: 'reverse', saleId: 'sale', attendanceId: 'attendance' },
  ])('rejects a malformed ledger row (%#)', async input => {
    const { sale, grant, memberId } = await lot();
    const kind = input.kind ?? 'adjust';
    const values: Partial<Entry> = { memberId, kind, credits: -1, lotId: kind === 'grant' ? null : grant.id, reason: null, adjustmentId: null,
      saleId: kind === 'grant' || kind === 'reverse' ? sale.id : null, attendanceId: kind === 'use' ? uuidv7() : null,
      ...(kind === 'adjust' ? { credits: 1, lotId: null, reason: 'Adjustment', adjustmentId: uuidv7() } : {}), ...input };
    if (values.lotId === 'lot') values.lotId = grant.id;
    if (values.attendanceId === 'attendance') values.attendanceId = uuidv7();
    if (values.saleId === 'sale') values.saleId = sale.id;
    if (values.adjustmentId === 'adjustment') values.adjustmentId = uuidv7();
    await expect(factory('classCreditEntries', gymA, values)).rejects.toMatchObject(rejected('23514'));
  });
});

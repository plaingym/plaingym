// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { allocateInvoiceNumber } from './invoice-numbers.js';
import { assertRevised, RevisionConflictError, revisionGuard } from './revision.js';
import * as schema from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
const database = useTestDatabase();
const factory = createFactories(database);
const gym = uuidv7(), otherGym = uuidv7();
const rejected = (code: string) => ({ cause: { code } });
const hash = () => createHash('sha256').update(uuidv7()).digest('hex');
beforeAll(async () => {
  await factory('gyms', gym, { currency: 'CAD' });
  await factory('gyms', otherGym);
});

describe('tax rates', () => {
  it('stores rates in millionths and lets a plan carry several separately stated taxes', async () => {
    const gst = await factory('taxRates', gym, { name: 'GST', rateMillionths: 50_000 });
    const qst = await factory('taxRates', gym, { name: 'QST', rateMillionths: 99_750 });
    const plan = await factory('plans', gym, { currency: 'CAD' });
    await factory('planTaxRates', gym, { planId: plan.id, taxRateId: gst.id });
    await factory('planTaxRates', gym, { planId: plan.id, taxRateId: qst.id });
    await expect(factory('planTaxRates', gym, { planId: plan.id, taxRateId: qst.id })).rejects.toMatchObject(rejected('23505'));
    await expect(factory('taxRates', gym, { rateMillionths: 1_000_001 })).rejects.toMatchObject(rejected('23514'));
    const charge = await factory('chargeTypes', gym, { currency: 'CAD' });
    await factory('chargeTypeTaxRates', gym, { chargeTypeId: charge.id, taxRateId: gst.id });
  });
  it('requires tax lines to snapshot their rate and treatment, and other lines to carry none', async () => {
    const invoice = await factory('invoices', gym, { currency: 'CAD' });
    const line = { householdId: invoice.householdId, invoiceId: invoice.id, currency: 'CAD' };
    await factory('invoiceLineItems', gym, { ...line, kind: 'tax', description: 'QST', amountCents: 998, taxRateMillionths: 99_750, taxInclusive: false });
    await expect(factory('invoiceLineItems', gym, { ...line, kind: 'tax', description: 'QST', amountCents: 998 })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('invoiceLineItems', gym, { ...line, kind: 'tax', description: 'QST', amountCents: 998, taxInclusive: false })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('invoiceLineItems', gym, { ...line, taxRateMillionths: 50_000, taxInclusive: false })).rejects.toMatchObject(rejected('23514'));
  });
});

describe('gym currency', () => {
  it('rejects amounts in another currency anywhere in the billing chain', async () => {
    await expect(factory('plans', gym, { currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    await expect(factory('chargeTypes', gym, { currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    await expect(factory('invoices', gym, { currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    const invoice = await factory('invoices', gym, { currency: 'CAD' });
    await expect(factory('invoiceLineItems', gym, { householdId: invoice.householdId, invoiceId: invoice.id, currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    await expect(factory('paymentAttempts', gym, { invoiceId: invoice.id, currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    await expect(factory('payments', gym, { invoiceId: invoice.id, currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
    const payment = await factory('payments', gym, { invoiceId: invoice.id, currency: 'CAD' });
    await expect(factory('refunds', gym, { paymentId: payment.id, currency: 'USD' })).rejects.toMatchObject(rejected('23503'));
  });
  it('builds generated money dependencies in the gym currency', async () => {
    const explicit = await factory('memberships', gym, { currency: 'CAD' });
    const inherited = await factory('memberships', gym);
    expect([explicit.currency, inherited.currency]).toEqual(['CAD', 'CAD']);
    const [plan] = await database.forGym(gym, (tx) => tx.select().from(schema.plans).where(eq(schema.plans.id, inherited.planId)));
    expect(plan?.currency).toBe('CAD');
    const refund = await factory('refunds', gym);
    expect(refund.currency).toBe('CAD');
    await factory('invoiceLineItems', gym);
    await factory('paymentAttempts', gym);
  });
  it('locks the gym currency once billing data references it', async () => {
    const fresh = uuidv7();
    await factory('gyms', fresh);
    const change = (currency: string) => database.forGym(fresh, (tx) => tx.update(schema.gyms).set({ currency }).where(eq(schema.gyms.id, fresh)).returning());
    expect(await change('EUR')).toHaveLength(1);
    await factory('plans', fresh, { currency: 'EUR' });
    await expect(change('USD')).rejects.toMatchObject(rejected('23503'));
  });
  it('still deletes a whole gym, billing history and append-only rows included', async () => {
    const doomed = uuidv7();
    await factory('gyms', doomed);
    const invoice = await factory('invoices', doomed, { status: 'open', number: 1 });
    await factory('invoiceLineItems', doomed, { householdId: invoice.householdId, invoiceId: invoice.id });
    const payment = await factory('payments', doomed, { invoiceId: invoice.id });
    await factory('refunds', doomed, { paymentId: payment.id });
    await factory('paymentAttempts', doomed, { invoiceId: invoice.id });
    const device = await factory('kioskDevices', doomed);
    await factory('auditEvents', doomed, { actorKind: 'device', actorDeviceId: device.id });
    await factory('waiverSignatures', doomed);
    await database.forSystem((tx) => tx.delete(schema.gyms).where(eq(schema.gyms.id, doomed)));
    for (const table of [schema.invoices, schema.payments, schema.auditEvents, schema.waiverSignatures]) {
      expect(await database.forGym(doomed, (tx) => tx.select().from(table))).toEqual([]);
    }
  });
});

describe('invoice numbers', () => {
  it('allocates per gym, never reuses a number under concurrency, and is unique', async () => {
    const numbers = await Promise.all(Array.from({ length: 12 }, () => database.forGym(gym, (tx) => allocateInvoiceNumber(tx, gym))));
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await database.forGym(otherGym, (tx) => allocateInvoiceNumber(tx, otherGym))).toBe(1);
    await expect(database.forGym(gym, async (tx) => {
      const number = await allocateInvoiceNumber(tx, gym);
      throw new Error('rollback ' + number);
    })).rejects.toThrow('rollback 13');
    expect(await database.forGym(gym, (tx) => allocateInvoiceNumber(tx, gym))).toBe(13);
    const issued = await factory('invoices', gym, { currency: 'CAD', status: 'open', number: 500 });
    await expect(factory('invoices', gym, { householdId: issued.householdId, currency: 'CAD', status: 'open', number: 500 })).rejects.toMatchObject(rejected('23505'));
  });
  it('numbers issued invoices only', async () => {
    await expect(factory('invoices', gym, { currency: 'CAD', number: 900 })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('invoices', gym, { currency: 'CAD', status: 'open' })).rejects.toMatchObject(rejected('23514'));
  });
});

describe('household ownership rules', () => {
  it('allows one active default card per household and never a revoked default', async () => {
    const household = await factory('households', gym);
    await factory('paymentMethods', gym, { householdId: household.id, isDefault: true });
    await expect(factory('paymentMethods', gym, { householdId: household.id, isDefault: true })).rejects.toMatchObject(rejected('23505'));
    await expect(factory('paymentMethods', gym, { householdId: household.id, isDefault: true, revokedAt: new Date() })).rejects.toMatchObject(rejected('23514'));
    await factory('paymentMethods', gym, { isDefault: true });
  });
  it('links each member to at most one portal account; several payers are allowed', async () => {
    const member = await factory('members', gym);
    const login = { householdId: member.householdId, scope: 'member', memberId: member.id } as const;
    await factory('householdUsers', gym, login);
    await expect(factory('householdUsers', gym, login)).rejects.toMatchObject(rejected('23505'));
    await factory('householdUsers', gym, { householdId: member.householdId, scope: 'payer' });
    await factory('householdUsers', gym, { householdId: member.householdId, scope: 'payer' });
  });
  it('allows staff profiles without a login', async () => {
    await factory('staffProfiles', gym, { userId: null });
    await factory('staffProfiles', gym, { userId: null });
  });
});

describe('ranks and audit actors', () => {
  it('rejects a promotion whose rank belongs to another rank system than the program', async () => {
    const program = await factory('programs', gym, { rankSystemId: (await factory('rankSystems', gym)).id });
    const otherRank = await factory('ranks', gym);
    await expect(factory('memberRanks', gym, { programId: program.id, rankId: otherRank.id, rankSystemId: otherRank.rankSystemId }))
      .rejects.toMatchObject(rejected('23503'));
    const rank = await factory('ranks', gym, { rankSystemId: program.rankSystemId! });
    await factory('memberRanks', gym, { programId: program.id, rankId: rank.id, rankSystemId: rank.rankSystemId });
    const unranked = await factory('programs', gym);
    await expect(factory('memberRanks', gym, { programId: unranked.id, rankId: rank.id, rankSystemId: rank.rankSystemId }))
      .rejects.toMatchObject(rejected('23503'));
  });
  it('records exactly one actor reference per actor kind, within the gym', async () => {
    const device = await factory('kioskDevices', gym);
    const user = await factory('authUser', gym);
    await factory('auditEvents', gym, { actorKind: 'device', actorDeviceId: device.id });
    await factory('auditEvents', gym, { actorKind: 'user', actorUserId: user.id });
    await expect(factory('auditEvents', gym, { actorKind: 'device', actorUserId: user.id })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('auditEvents', gym, { actorKind: 'system', actorDeviceId: device.id })).rejects.toMatchObject(rejected('23514'));
    const foreignDevice = await factory('kioskDevices', otherGym);
    await expect(factory('auditEvents', gym, { actorKind: 'device', actorDeviceId: foreignDevice.id })).rejects.toMatchObject(rejected('23503'));
  });
});

describe('format checks', () => {
  it('requires lowercase emails and SHA-256 hex hashes', async () => {
    await expect(factory('authUser', gym, { email: 'Owner@Example.test' })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('kioskDevices', gym, { tokenHash: 'not-a-hash' })).rejects.toMatchObject(rejected('23514'));
    await expect(factory('members', gym, { checkinCodeHash: 'NOT-A-HASH' })).rejects.toMatchObject(rejected('23514'));
    await factory('members', gym, { checkinCodeHash: hash() });
  });
});

describe('revisions', () => {
  it('applies a save only at the expected revision and increments it', async () => {
    const member = await factory('members', gym);
    const save = (expected: number, firstName: string) => database.forGym(gym, async (tx) => {
      const guard = revisionGuard(schema.members.revision, expected);
      return assertRevised(await tx.update(schema.members).set({ firstName, revision: guard.next })
        .where(and(eq(schema.members.id, member.id), guard.matches)).returning());
    });
    expect((await save(1, 'First')).revision).toBe(2);
    await expect(save(1, 'Stale')).rejects.toBeInstanceOf(RevisionConflictError);
    const [row] = await database.forGym(gym, (tx) => tx.select().from(schema.members).where(eq(schema.members.id, member.id)));
    expect(row).toMatchObject({ firstName: 'First', revision: 2 });
  });
});

it('exposes no relational query API that could reach system tables without an import', async () => {
  await database.forGym(gym, async (tx) => {
    expect(Object.keys((tx as unknown as { query?: object }).query ?? {})).toEqual([]);
  });
});

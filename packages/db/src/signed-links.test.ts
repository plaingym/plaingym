// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import type { HouseholdScope } from './household.js';
import { uuidv7 } from './id.js';
import { signedLinks } from './schema/links.js';
import { useTestDatabase } from './testing/database.js';
import { createFactories } from './testing/factories.js';
import { isInTransaction } from '@plaingym/shared/transaction';

const database = useTestDatabase();
const factory = createFactories(database);
const gym = uuidv7(), otherGym = uuidv7();
const now = new Date('2026-01-15T12:00:00Z');
const expiresAt = new Date('2026-01-16T12:00:00Z');
const purposes = ['pay_invoice', 'update_card', 'sign_waiver', 'onboarding'] as const;
type Purpose = typeof purposes[number];

async function seed() {
  await factory('gyms', gym); await factory('gyms', otherGym);
  const household = await factory('households', gym);
  const otherHousehold = await factory('households', gym);
  const foreignHousehold = await factory('households', otherGym);
  const member = await factory('members', gym, { householdId: household.id });
  const sibling = await factory('members', gym, { householdId: household.id });
  const outsider = await factory('members', gym, { householdId: otherHousehold.id });
  const foreignMember = await factory('members', otherGym, { householdId: foreignHousehold.id });
  const invoice = await factory('invoices', gym, { householdId: household.id });
  const otherInvoice = await factory('invoices', gym, { householdId: household.id });
  const outsiderInvoice = await factory('invoices', gym, { householdId: otherHousehold.id });
  const foreignInvoice = await factory('invoices', otherGym, { householdId: foreignHousehold.id });
  for (const row of [invoice, otherInvoice, outsiderInvoice]) {
    await factory('invoiceLineItems', gym, { householdId: row.householdId, invoiceId: row.id });
  }
  const card = await factory('paymentMethods', gym, { householdId: household.id });
  await factory('paymentMethods', gym, { householdId: otherHousehold.id });
  const oldTemplate = await factory('waiverTemplates', gym, { name: 'Waiver', version: 1 });
  const currentTemplate = await factory('waiverTemplates', gym, { name: 'Waiver', version: 2 });
  const agreement = await factory('waiverTemplates', gym, { name: 'Agreement', version: 1, kind: 'agreement' });
  await factory('waiverTemplates', otherGym, { name: 'Waiver', version: 99 });
  for (const person of [member, sibling, outsider]) {
    await factory('waiverSignatures', gym, { memberId: person.id, templateId: currentTemplate.id });
    await factory('classBookings', gym, { memberId: person.id });
    await factory('attendances', gym, { memberId: person.id });
    await factory('memberRanks', gym, { memberId: person.id });
    await factory('memberships', gym, { memberId: person.id, householdId: person.householdId });
  }
  return { household, otherHousehold, foreignHousehold, member, sibling, outsider, foreignMember,
    invoice, otherInvoice, outsiderInvoice, foreignInvoice, card, oldTemplate, currentTemplate, agreement };
}
let data: Awaited<ReturnType<typeof seed>>;
beforeAll(async () => { data = await seed(); });

function makeLink(purpose: Purpose) {
  return factory('signedLinks', gym, {
    householdId: data.household.id, purpose, expiresAt,
    invoiceId: purpose === 'pay_invoice' ? data.invoice.id : null,
    memberId: purpose === 'sign_waiver' ? data.member.id : null,
  });
}
function linkScope(linkId: string): HouseholdScope {
  return { kind: 'signed_link', gymId: gym, linkId, now };
}

describe('signed-link household grants', () => {
  it.each(purposes)('%s permits exactly its documented query surface', async (purpose) => {
    const link = await makeLink(purpose);
    await database.forHousehold(linkScope(link.id), async (queries) => {
      expect(isInTransaction()).toBe(true);
      const memberIds = purpose === 'onboarding' ? [data.member.id, data.sibling.id]
        : purpose === 'sign_waiver' ? [data.member.id] : [];
      if (memberIds.length) {
        expect((await queries.members()).map((row) => row.id).sort()).toEqual(memberIds.sort());
        const waivers = await queries.waivers();
        expect(waivers.map((row) => row.memberId).sort()).toEqual(memberIds.sort());
        expect(waivers.every((row) => !("ipAddress" in row))).toBe(true);
        expect(await queries.member(data.outsider.id)).toEqual([]);
        expect(await queries.member(data.foreignMember.id)).toEqual([]);
        expect(await queries.member(data.sibling.id)).toHaveLength(purpose === 'onboarding' ? 1 : 0);
        expect(await queries.member(data.member.id)).toHaveLength(1);
        expect((await queries.waiverTemplates()).map((row) => row.id).sort())
          .toEqual([data.currentTemplate.id, data.agreement.id].sort());
      } else {
        for (const query of [queries.members, queries.waivers, queries.waiverTemplates,
          () => queries.member(data.member.id)]) await expect(query()).rejects.toThrow('access denied');
      }
      if (purpose === 'pay_invoice') {
        expect((await queries.invoices()).map((row) => row.id)).toEqual([data.invoice.id]);
        expect(await queries.invoice(data.invoice.id)).toHaveLength(1);
        expect(await queries.invoiceLines(data.invoice.id)).toHaveLength(1);
        for (const invoice of [data.otherInvoice, data.outsiderInvoice, data.foreignInvoice]) {
          expect(await queries.invoice(invoice.id)).toEqual([]);
          expect(await queries.invoiceLines(invoice.id)).toEqual([]);
        }
      } else {
        for (const query of [queries.invoices, () => queries.invoice(data.invoice.id),
          () => queries.invoiceLines(data.invoice.id)]) await expect(query()).rejects.toThrow('Payer access required');
      }
      if (purpose === 'update_card' || purpose === 'onboarding') {
        expect(await queries.paymentMethods()).toEqual([{
          id: data.card.id, brand: 'visa', last4: '4242', expiryMonth: null, expiryYear: null,
        }]);
      } else {
        await expect(queries.paymentMethods()).rejects.toThrow('Payer access required');
      }
      await expect(queries.household()).rejects.toThrow('Payer access required');
      for (const query of [queries.bookings, queries.attendance, queries.ranks, queries.memberships]) {
        await expect(query()).rejects.toThrow('access denied');
      }
      expect(queries).not.toHaveProperty('execute');
    });
    expect(isInTransaction()).toBe(false);
  });

  it('takes household and resource only from the row, ignoring forged routing claims', async () => {
    const link = await makeLink('pay_invoice');
    const scope = {
      kind: 'signed_link' as const, gymId: gym, linkId: link.id, now,
      householdId: data.otherHousehold.id, invoiceId: data.outsiderInvoice.id, memberId: data.outsider.id,
    };
    await database.forHousehold(scope, async (queries) => {
      expect((await queries.invoices()).map((row) => row.id)).toEqual([data.invoice.id]);
      expect(await queries.invoice(data.outsiderInvoice.id)).toEqual([]);
    });
  });

  it.each(['revoked', 'used', 'expired', 'at_expiry'] as const)('rejects a %s link before invoking its callback', async (state) => {
    const link = await makeLink('onboarding');
    const changes = state === 'revoked' ? { revokedAt: now } : state === 'used' ? { usedAt: now }
      : { expiresAt: new Date(now.getTime() - (state === 'expired' ? 1 : 0)) };
    await database.forGym(gym, (tx) => tx.update(signedLinks).set(changes).where(eq(signedLinks.id, link.id)));
    let invoked = false;
    await expect(database.forHousehold(linkScope(link.id), async () => { invoked = true; }))
      .rejects.toThrow('Household access denied');
    expect(invoked).toBe(false);
  });

  it('rechecks a previously valid link and refuses another gym or a missing link', async () => {
    const link = await makeLink('pay_invoice');
    const scope = linkScope(link.id);
    await database.forHousehold(scope, async (queries) => expect(await queries.invoice(data.invoice.id)).toHaveLength(1));
    await expect(database.forHousehold({ ...scope, gymId: otherGym }, async () => undefined)).rejects.toThrow('access denied');
    await expect(database.forHousehold(linkScope(uuidv7()), async () => undefined)).rejects.toThrow('access denied');
    await database.forGym(gym, (tx) => tx.update(signedLinks).set({ usedAt: now }).where(eq(signedLinks.id, link.id)));
    await expect(database.forHousehold(scope, async () => undefined)).rejects.toThrow('access denied');
    await expect(database.forHousehold({ kind: 'signed_link', gymId: gym, linkId: link.id, now: new Date(NaN) }, async () => undefined))
      .rejects.toThrow('access denied');
  });
});

describe('signed-link resource constraints', () => {
  it.each(['invoice', 'member'] as const)('rejects another household or gym owning the linked %s', async (resource) => {
    const overrides = resource === 'invoice'
      ? [{ purpose: 'pay_invoice', invoiceId: data.outsiderInvoice.id }, { purpose: 'pay_invoice', invoiceId: data.foreignInvoice.id }]
      : [{ purpose: 'sign_waiver', memberId: data.outsider.id }, { purpose: 'sign_waiver', memberId: data.foreignMember.id }];
    for (const value of overrides) {
      await expect(factory('signedLinks', gym, { householdId: data.household.id, ...value }))
        .rejects.toMatchObject({ cause: { code: '23503' } });
    }
  });

  it.each(purposes)('requires exactly the resource columns for %s', async (purpose) => {
    const combinations = [
      { invoiceId: null, memberId: null }, { invoiceId: data.invoice.id, memberId: null },
      { invoiceId: null, memberId: data.member.id }, { invoiceId: data.invoice.id, memberId: data.member.id },
    ];
    for (const pair of combinations) {
      const valid = purpose === 'pay_invoice' ? pair.invoiceId !== null && pair.memberId === null
        : purpose === 'sign_waiver' ? pair.memberId !== null && pair.invoiceId === null
        : pair.invoiceId === null && pair.memberId === null;
      const insert = factory('signedLinks', gym, { householdId: data.household.id, purpose, ...pair });
      if (valid) await expect(insert).resolves.toMatchObject({ purpose, ...pair });
      else await expect(insert).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
const database = useTestDatabase();
const factory = createFactories(database);
const gym = uuidv7(), otherGym = uuidv7();
beforeAll(async () => { await factory('gyms', gym); await factory('gyms', otherGym); });
it('scopes every household query and restricts the adult non-payer to their own data', async () => {
  const first = await factory('households', gym), second = await factory('households', gym);
  const payer = await factory('authUser', gym), adult = await factory('authUser', gym);
  const member = await factory('members', gym, { householdId: first.id });
  const child = await factory('members', gym, { householdId: first.id });
  const outsider = await factory('members', gym, { householdId: second.id });
  await factory('householdUsers', gym, { householdId: first.id, userId: payer.id, scope: 'payer' });
  await factory('householdUsers', gym, { householdId: first.id, userId: adult.id, scope: 'member', memberId: member.id });
  const ownInvoice = await factory('invoices', gym, { householdId: first.id });
  const otherInvoice = await factory('invoices', gym, { householdId: second.id });
  await factory('invoiceLineItems', gym, { householdId: first.id, invoiceId: ownInvoice.id });
  await factory('invoiceLineItems', gym, { householdId: second.id, invoiceId: otherInvoice.id });
  await factory('paymentMethods', gym, { householdId: first.id });
  await factory('paymentMethods', gym, { householdId: second.id });
  for (const person of [member, child, outsider]) {
    await factory('classBookings', gym, { memberId: person.id });
    await factory('waiverSignatures', gym, { memberId: person.id });
    await factory('attendances', gym, { memberId: person.id });
    await factory('memberRanks', gym, { memberId: person.id });
    await factory('memberships', gym, { memberId: person.id, householdId: person.householdId });
  }
  await database.forHousehold({ kind: 'user', gymId: gym, householdId: first.id, userId: payer.id }, async (queries) => {
    expect((await queries.members()).map((row) => row.id).sort()).toEqual([member.id, child.id].sort());
    expect(await queries.member(outsider.id)).toEqual([]);
    expect((await queries.invoices()).map((row) => row.id)).toEqual([ownInvoice.id]);
    expect(await queries.invoice(otherInvoice.id)).toEqual([]);
    expect(await queries.invoiceLines(otherInvoice.id)).toEqual([]);
    expect(await queries.invoiceLines(ownInvoice.id)).toHaveLength(1);
    expect(await queries.paymentMethods()).toHaveLength(1);
    expect(await queries.household()).toHaveLength(1);
    for (const query of [queries.bookings, queries.waivers, queries.attendance, queries.ranks, queries.memberships]) expect(await query()).toHaveLength(2);
    expect(queries).not.toHaveProperty('execute');
  });
  await database.forHousehold({ kind: 'user', gymId: gym, householdId: first.id, userId: adult.id }, async (queries) => {
    expect((await queries.members()).map((row) => row.id)).toEqual([member.id]);
    expect(await queries.member(child.id)).toEqual([]);
    for (const query of [queries.bookings, queries.waivers, queries.attendance, queries.ranks, queries.memberships]) expect(await query()).toHaveLength(1);
    for (const query of [queries.invoices, queries.paymentMethods, queries.household]) await expect(query()).rejects.toThrow('Payer');
  });
  await expect(database.forHousehold({ kind: 'user', gymId: gym, householdId: second.id, userId: payer.id }, async () => undefined)).rejects.toThrow('access denied');
  await expect(database.forHousehold({ kind: 'user', gymId: otherGym, householdId: first.id, userId: payer.id }, async () => undefined)).rejects.toThrow('access denied');
});

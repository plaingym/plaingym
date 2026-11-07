// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, expect, it } from 'vitest';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
import { HouseholdAccessError } from './household.js';
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
  await factory('paymentMethods', gym, { householdId: first.id, revokedAt: new Date('2026-01-01Z') });
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
    // List and detail share one projection: emergency contacts for household users, never medical notes.
    const [detail] = await queries.member(child.id);
    expect(detail).toEqual((await queries.members()).find((row) => row.id === child.id));
    expect(detail).toHaveProperty('emergencyContacts');
    expect(detail).not.toHaveProperty('medicalNotes');
    expect(detail).not.toHaveProperty('checkinCodeHash');
    expect((await queries.invoices()).map((row) => row.id)).toEqual([ownInvoice.id]);
    expect(await queries.invoice(otherInvoice.id)).toEqual([]);
    expect(await queries.invoiceLines(otherInvoice.id)).toEqual([]);
    expect(await queries.invoiceLines(ownInvoice.id)).toHaveLength(1);
    expect(await queries.paymentMethods()).toHaveLength(1);
    // Payers edit household details with compare-and-set, so the read carries the revision; PIN hash stays staff-only.
    const [profile] = await queries.household();
    expect(profile).toEqual({ id: first.id, name: first.name, email: null, phone: null, address: {}, billingDay: 1, revision: 1 });
    for (const query of [queries.bookings, queries.waivers, queries.attendance, queries.ranks, queries.memberships]) expect(await query()).toHaveLength(2);
    expect(queries).not.toHaveProperty('execute');
  });
  await database.forHousehold({ kind: 'user', gymId: gym, householdId: first.id, userId: adult.id }, async (queries) => {
    expect((await queries.members()).map((row) => row.id)).toEqual([member.id]);
    expect((await queries.members())[0]).toHaveProperty('emergencyContacts');
    expect(await queries.member(child.id)).toEqual([]);
    for (const query of [queries.bookings, queries.waivers, queries.attendance, queries.ranks, queries.memberships]) expect(await query()).toHaveLength(1);
    for (const query of [queries.invoices, queries.paymentMethods, queries.household]) await expect(query()).rejects.toThrow('Payer');
  });
  await expect(database.forHousehold({ kind: 'user', gymId: gym, householdId: second.id, userId: payer.id }, async () => undefined)).rejects.toThrow('access denied');
  await expect(database.forHousehold({ kind: 'user', gymId: otherGym, householdId: first.id, userId: payer.id }, async () => undefined)).rejects.toThrow('access denied');
});
it('keeps every bounded read inside the grant, whatever IDs the caller names', async () => {
  const first = await factory('households', gym), second = await factory('households', gym);
  const payer = await factory('authUser', gym), adult = await factory('authUser', gym);
  const member = await factory('members', gym, { householdId: first.id });
  const child = await factory('members', gym, { householdId: first.id });
  const outsider = await factory('members', gym, { householdId: second.id });
  await factory('householdUsers', gym, { householdId: first.id, userId: payer.id, scope: 'payer' });
  await factory('householdUsers', gym, { householdId: first.id, userId: adult.id, scope: 'member', memberId: member.id });
  const template = await factory('waiverTemplates', gym);
  const seeded = new Map<string, { booking: string; session: string; signature: string }>();
  for (const person of [member, child, outsider]) {
    const session = await factory('classSessions', gym);
    const booking = await factory('classBookings', gym, { memberId: person.id, sessionId: session.id });
    const signature = await factory('waiverSignatures', gym, { memberId: person.id, templateId: template.id });
    await factory('attendances', gym, { memberId: person.id });
    await factory('memberRanks', gym, { memberId: person.id, notes: 'Coach note' });
    await factory('memberships', gym, { memberId: person.id, householdId: person.householdId });
    seeded.set(person.id, { booking: booking.id, session: session.id, signature: signature.id });
  }
  await factory('invoices', gym, { householdId: first.id, status: 'draft' });
  const issued = await factory('invoices', gym, { householdId: first.id, status: 'open', number: 9001 });
  await factory('invoices', gym, { householdId: second.id, status: 'open', number: 9002 });
  const page = { limit: 50, offset: 0 }, none = { rows: [], total: 0 };
  /** Every bounded read for one member the scope must not reach. */
  async function nothing(queries: Parameters<Parameters<typeof database.forHousehold>[1]>[0], memberId: string) {
    const row = seeded.get(memberId)!;
    expect(await queries.bookingPage({ memberId }, page)).toEqual(none);
    expect(await queries.booking(row.booking, memberId)).toEqual([]);
    expect(await queries.sessionBookings([row.session], [memberId])).toEqual([]);
    expect(await queries.attendancePage({ memberId }, page)).toEqual(none);
    expect(await queries.attendanceCount({ memberId })).toBe(0);
    expect(await queries.rankHistory(memberId)).toEqual([]);
    expect(await queries.membershipPage(memberId, page)).toEqual(none);
    expect(await queries.signaturePage([memberId], page)).toEqual(none);
    expect(await queries.signature(row.signature, [memberId])).toEqual([]);
    expect(await queries.signedTemplates([memberId], [template.id])).toEqual([]);
  }
  await database.forHousehold({ kind: 'user', gymId: gym, householdId: first.id, userId: payer.id }, async (queries) => {
    await nothing(queries, outsider.id);
    const own = seeded.get(child.id)!;
    expect((await queries.bookingPage({ memberId: child.id }, page)).rows.map((row) => row.id)).toEqual([own.booking]);
    expect(await queries.booking(own.booking, child.id)).toEqual([{ id: own.booking }]);
    // Naming one household member can't reach another's booking.
    expect(await queries.booking(own.booking, member.id)).toEqual([]);
    expect((await queries.attendancePage({}, page)).total).toBe(2);
    expect(await queries.attendanceCount({})).toBe(2);
    expect(await queries.attendanceCount({ kind: 'open_mat' })).toBe(0);
    const [promotion] = await queries.rankHistory(child.id);
    expect(promotion).toBeDefined();
    expect(promotion).not.toHaveProperty('notes');
    expect(promotion).not.toHaveProperty('promotedBy');
    expect((await queries.membershipPage(child.id, page)).rows[0]).not.toHaveProperty('amountCents');
    // Only issued invoices of this household, in the portal's projection.
    const invoices = await queries.invoicePage({}, page);
    expect(invoices.rows.map((row) => row.id)).toEqual([issued.id]);
    expect(invoices.total).toBe(1);
    expect(invoices.rows[0]).not.toHaveProperty('checkoutSessionId');
    const [profile] = await queries.member(child.id);
    expect(profile).toHaveProperty('createdAt', child.createdAt);
  });
  await database.forHousehold({ kind: 'user', gymId: gym, householdId: first.id, userId: adult.id }, async (queries) => {
    await nothing(queries, child.id);
    await nothing(queries, outsider.id);
    expect((await queries.bookingPage({ memberId: member.id }, page)).total).toBe(1);
    expect((await queries.attendancePage({}, page)).total).toBe(1);
    await expect(queries.invoicePage({}, page)).rejects.toMatchObject({ code: 'payer_access_required' });
  });
});
it('refuses with a typed code at the grant and at each query', async () => {
  const home = await factory('households', gym), payer = await factory('authUser', gym), member = await factory('members', gym, { householdId: home.id });
  const denied = database.forHousehold({ kind: 'user', gymId: gym, householdId: home.id, userId: payer.id }, async () => undefined);
  await expect(denied).rejects.toBeInstanceOf(HouseholdAccessError);
  await expect(denied).rejects.toMatchObject({ code: 'household_access_denied' });
  const link = await factory('signedLinks', gym, { householdId: home.id, purpose: 'update_card', expiresAt: new Date('2030-01-01Z') });
  await database.forHousehold({ kind: 'signed_link', gymId: gym, linkId: link.id, now: new Date('2026-01-01Z') }, async (queries) => {
    const page = { limit: 10, offset: 0 };
    for (const read of [() => queries.bookingPage({ memberId: member.id }, page), () => queries.booking(link.id, member.id), () => queries.sessionBookings([link.id], [member.id]),
      () => queries.attendancePage({}, page), () => queries.attendanceCount({}), () => queries.rankHistory(member.id), () => queries.membershipPage(member.id, page),
      () => queries.signaturePage([member.id], page), () => queries.signature(link.id, [member.id]), () => queries.signedTemplates([member.id], [link.id])])
      await expect(read()).rejects.toMatchObject({ code: 'household_access_denied' });
    await expect(queries.invoicePage({}, page)).rejects.toMatchObject({ code: 'payer_access_required' });
  });
});

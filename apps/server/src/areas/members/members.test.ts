// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq, inArray } from 'drizzle-orm';
import { members, memberRanks, memberships, waiverSignatures, households, invoices, invoiceLineItems, attendances, householdUsers, signedLinks, auditEvents, paymentMethods, classBookings, classSessions, staffProfiles, allocateInvoiceNumber, uuidv7, RevisionConflictError } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, staffRoles, type StaffRole } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { createMembersService } from './members.js';
import { createErasureJobs, createMembersRoutes, redactCustomerJob } from './members.routes.js';
import { createMemberPhotoJobs } from './members.jobs.js';
import { createMemberPhotoService } from './photos.js';
import { hashHouseholdPin, verifyHouseholdPin } from './pin.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { setLogSink } from '../../core/log.js';
import { errorHandler, respondError } from '../../core/errors.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const gymA = uuidv7(), gymB = uuidv7(), secretA = new Uint8Array(32).fill(17), secretB = new Uint8Array(32).fill(29);
const service = createMembersService({ scope: database.forGym, clock, pinSecret: async (gymId) => gymId === gymA ? secretA : secretB });
const stores = new Map<string, FakeUploads>(), uploadsFor = async (gymId: string) => {
  if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock)); return stores.get(gymId)!;
};
const photos = createMemberPhotoService(service, uploadsFor);
const context = (gymId = gymA) => ({ gymId, actor: { kind: 'system' as const } });
let userId: string;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); userId = (await factory('authUser', gymA)).id; });
function server(principal: Principal, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
  app.use('*', async (ctx, next) => { ctx.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, requestId: 'test', clock }); await next(); });
  app.onError(errorHandler);
  createServerRegistry({ routes: createMembersRoutes(service, uploadsFor) }).mount(app, authorize, new Set()); return app;
}
function erasureServer(erasure: Parameters<typeof createMembersRoutes>[2]) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => { ctx.set('context', { principal: { kind: 'staff', gymId: gymA, userId, roles: ['owner'] }, gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() }, requestId: 'erase', clock }); await next(); });
  app.onError(errorHandler);
  createServerRegistry({ routes: createMembersRoutes(service, uploadsFor, erasure) }).mount(app, authorize, new Set());
  return app;
}
const staff = (role: StaffRole, gymId = gymA) => server({ kind: 'staff', userId, gymId, roles: [role] }, gymId);
const send = (app: ReturnType<typeof server>, path: string, method = 'GET', body?: unknown) => app.request(path, { method,
  ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

async function routeFixture(gymId: string) {
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id, medicalNotes: 'private health detail' });
  const tag = await factory('memberTags', gymId);
  return { home, person, tag };
}
async function requestFor(definition: ReturnType<typeof createMembersRoutes>[number]['definition'], gymId: string) {
  const { home, person, tag } = await routeFixture(gymId);
  if (definition.method === 'get' && definition.path.endsWith('/photo')) await photos.upload(context(gymId), person.id, 1, png, 'image/png');
  const householdId = definition.method === 'delete' && definition.path === '/api/households/{householdId}' ? (await factory('households', gymId)).id : home.id;
  const path = definition.path.replace('{memberId}', person.id).replace('{householdId}', householdId).replace('{tagId}', tag.id);
  let body: unknown;
  if (definition.method === 'delete' && !definition.path.endsWith('/tags/{tagId}')) body = { revision: 1 };
  if (definition.method !== 'get' && definition.method !== 'delete') {
    body = definition.path === '/api/members' ? { householdId: home.id, firstName: 'A', lastName: 'Member' }
      : definition.path === '/api/households' ? { name: 'Family' }
      : definition.path === '/api/member-tags' ? { name: uuidv7() }
      : definition.path.endsWith('/medical-notes') ? { revision: 1, medicalNotes: 'Updated medical' }
      : definition.path.endsWith('/anonymize') ? { revision: 1 }
      : definition.path.endsWith('/billing-settings') ? { revision: 1, billingDay: 31, familyDiscountBasisPoints: 100 }
      : definition.path.endsWith('/pin') ? { revision: 1, pin: '1234' }
      : definition.path.endsWith('/photo') ? { revision: 1, contentType: 'image/png', base64: png.toString('base64') }
      : definition.path.endsWith('/tags') ? { tagId: tag.id }
      : definition.path.includes('member-tags') ? { revision: 1, color: '#123456' }
      : definition.path.includes('households') ? { revision: 1, name: 'New family' }
      : { revision: 1, firstName: 'Updated' };
  }
  return { path, method: definition.method.toUpperCase(), body, foreignIds: [person.id, householdId, tag.id] };
}
describe('member route access boundaries', () => {
  it.each(staffRoles)('checks every route, including additional medical permission, for %s', async (role) => {
    for (const entry of createMembersRoutes(service, uploadsFor)) {
      const request = await requestFor(entry.definition, gymA);
      const permissions = [entry.definition.permission, ...(entry.definition.additionalPermissions ?? [])];
      const allowed = permissions.every((permission) => permission.kind === 'staff' && canStaff([role], permission.capability));
      const response = await send(staff(role), request.path, request.method, request.body);
      expect(response.status, role + ' ' + entry.id + ' ' + (response.status === 500 ? await response.text() : '')).toBe(allowed ? 200 : 403);
      if (response.ok && !request.path.endsWith('/photo')) {
        const text = await response.text();
        if (!request.path.endsWith('/medical-notes')) expect(text).not.toMatch(/medicalNotes|private health detail/);
        expect(text).not.toMatch(/pinHash|checkinCodeHash|stripeCustomerId/);
      }
    }
  });
  it('returns 404 for foreign gym resources on every resource route and rejects foreign create references', async () => {
    for (const entry of createMembersRoutes(service, uploadsFor)) {
      const request = await requestFor(entry.definition, gymB);
      if (entry.definition.path.includes('{') || entry.definition.path === '/api/members' && entry.definition.method === 'post') {
        expect((await send(staff('owner'), request.path, request.method, request.body)).status, entry.id).toBe(404);
      } else if (entry.definition.method === 'get') {
        const response = await send(staff('owner'), request.path);
        const json = await response.json();
        for (const foreignId of request.foreignIds) expect(JSON.stringify(json)).not.toContain(foreignId);
      }
    }
    const own = await routeFixture(gymA), other = await routeFixture(gymB);
    expect((await send(staff('owner'), `/api/members/${own.person.id}/tags`, 'POST', { tagId: other.tag.id })).status).toBe(404);
    expect((await send(staff('owner'), '/api/members?householdId=' + other.home.id)).status).toBe(404);
    expect((await send(staff('owner'), '/api/members?tagId=' + other.tag.id)).status).toBe(404);
  });
  it('denies household logins, signed links, devices and anonymous callers on every admin route', async () => {
    const a = await routeFixture(gymA), b = await routeFixture(gymA);
    for (const principal of [
      { kind: 'member', userId, scope: { role: 'payer', gymId: gymA, householdId: a.home.id } },
      { kind: 'member', userId, scope: { role: 'member', gymId: gymA, householdId: b.home.id, memberId: b.person.id } },
      { kind: 'signed_link', gymId: gymA, linkId: uuidv7(), householdId: a.home.id, link: { purpose: 'onboarding' } },
      { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() }, { kind: 'anonymous' },
    ] satisfies Principal[]) {
      for (const entry of createMembersRoutes(service, uploadsFor)) {
        const request = await requestFor(entry.definition, gymA);
        const response = await send(server(principal), request.path, request.method, request.body);
        expect([401, 403, 404], entry.id).toContain(response.status);
      }
    }
  });
});

describe('members and households', () => {
  it('filters and pages by status, tag, household and literal search without leaking medical notes', async () => {
    const home = await service.createHousehold(context(), { name: 'Roster family' });
    const a = await service.createMember(context(), { householdId: home.id, firstName: 'Percent%name', lastName: 'Family', status: 'active' });
    await service.createMember(context(), { householdId: home.id, firstName: 'Other', lastName: 'Family', status: 'trial' });
    const tag = await service.createTag(context(), { name: uuidv7() });
    await service.addTag(context(), a.id, { tagId: tag.id }); await service.addTag(context(), a.id, { tagId: tag.id });
    const result = await service.listMembers(gymA, { householdId: home.id, status: 'active', tagId: tag.id, search: '%', limit: 1, offset: 0 });
    expect(result.data.map((row) => row.id)).toEqual([a.id]); expect(result.pagination.total).toBe(1);
    expect(await service.listMemberTags(gymA, a.id)).toHaveLength(1);
    expect(c.memberListResponseSchema.safeParse(result).success).toBe(true);
    expect(a.createdAt).toBe(clock.now().toISOString());
  });
  it('rejects stale revisions and racing edits with 409 and audits only committed mutations', async () => {
    const { person, home } = await routeFixture(gymA);
    const results = await Promise.allSettled([service.updateMember(context(), person.id, { revision: 1, firstName: 'One' }), service.updateMember(context(), person.id, { revision: 1, firstName: 'Two' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await send(staff('owner'), `/api/members/${person.id}`, 'PATCH', { revision: 1, firstName: 'Stale' })).status).toBe(409);
    await service.updateHousehold(context(), home.id, { revision: 1, name: 'Changed' });
    await expect(service.updateHouseholdBilling(context(), home.id, { revision: 1, billingDay: 2, familyDiscountBasisPoints: 0 })).rejects.toBeInstanceOf(RevisionConflictError);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, person.id)));
    expect(audits).toHaveLength(1); expect(audits[0]!.occurredAt).toEqual(clock.now());
    expect(JSON.stringify(audits)).not.toMatch(/firstName|medical|Stale/);
  });
  it('stores a household-bound keyed PIN hash, clears it, and never returns it', async () => {
    const { home } = await routeFixture(gymA);
    const saved = await service.setHouseholdPin(context(), home.id, { revision: 1, pin: '1234' });
    const [raw] = await database.forGym(gymA, (tx) => tx.select({ pin: households.pinHash }).from(households).where(eq(households.id, home.id)));
    expect(raw!.pin).toBe(hashHouseholdPin(secretA, gymA, home.id, '1234'));
    expect(verifyHouseholdPin(secretA, gymA, home.id, '1234', raw!.pin)).toBe(true);
    expect(verifyHouseholdPin(secretB, gymB, home.id, '1234', raw!.pin)).toBe(false);
    expect(verifyHouseholdPin(secretA, gymA, uuidv7(), '1234', raw!.pin)).toBe(false);
    expect(saved).not.toHaveProperty('pinHash'); expect(saved).not.toHaveProperty('pin');
    await service.setHouseholdPin(context(), home.id, { revision: 2, pin: null });
    expect(verifyHouseholdPin(secretA, gymA, home.id, '1234', null)).toBe(false);
    expect(verifyHouseholdPin(secretA, gymA, home.id, 'bad', raw!.pin)).toBe(false);
  });
  it('deletes unused households and tags with revision guards while retaining households with member or invoice references', async () => {
    const home = await service.createHousehold(context(), { name: 'Empty' });
    await expect(service.deleteHousehold(context(), home.id, 2)).rejects.toBeInstanceOf(RevisionConflictError);
    await service.deleteHousehold(context(), home.id, 1);
    await expect(service.getHousehold(gymA, home.id)).rejects.toMatchObject({ code: 'not_found' });
    const fixture = await routeFixture(gymA);
    await expect(service.deleteHousehold(context(), fixture.home.id, 1)).rejects.toMatchObject({ code: 'conflict' });
    await service.addTag(context(), fixture.person.id, { tagId: fixture.tag.id });
    await expect(service.deleteTag(context(), fixture.tag.id, 2)).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await service.listMemberTags(gymA, fixture.person.id)).toHaveLength(1);
    await service.deleteTag(context(), fixture.tag.id, 1);
    expect(await service.listMemberTags(gymA, fixture.person.id)).toHaveLength(0);
  });
  it('anonymizes PII and revokes access while retaining invoice, invoice-line and attendance IDs', async () => {
    const home = await factory('households', gymA, { name: 'Private family', email: 'private@example.test', phone: '123', address: { line1: 'Private street' }, pinHash: 'a'.repeat(64) });
    const person = await factory('members', gymA, { householdId: home.id, firstName: 'Private', lastName: 'Person', email: 'person@example.test', phone: '555', dateOfBirth: '2000-01-01', medicalNotes: 'Private condition', emergencyContacts: [{ name: 'Private contact' }], checkinCodeHash: 'b'.repeat(64) });
    const invoice = await factory('invoices', gymA, { householdId: home.id });
    const line = await factory('invoiceLineItems', gymA, { householdId: home.id, invoiceId: invoice.id });
    const attendance = await factory('attendances', gymA, { memberId: person.id });
    const promotion = await factory('memberRanks', gymA, { memberId: person.id, notes: 'Private Person, 555-0100, asthma' });
    const otherPromotion = await factory('memberRanks', gymA, { notes: 'Someone else' });
    const signatureKey = gymA + '/waivers/' + uuidv7();
    await (await uploadsFor(gymA)).put(signatureKey, png, 'image/png');
    await factory('waiverSignatures', gymA, { memberId: person.id, signatureImageKey: signatureKey });
    const otherWaiver = await factory('waiverSignatures', gymA);
    await factory('householdUsers', gymA, { householdId: home.id, userId, scope: 'payer', memberId: person.id });
    const signed = await factory('signedLinks', gymA, { householdId: home.id, purpose: 'onboarding' });
    // Supply valid contacts before uploading; the fixture intentionally exercises scrubbing JSON too.
    await database.forGym(gymA, (tx) => tx.update(members).set({ emergencyContacts: [{ name: 'Private contact', phone: '123', email: null, relationship: null }] }).where(eq(members.id, person.id)));
    const uploaded = await photos.upload(context(), person.id, 1, png, 'image/png');
    const saved = await photos.anonymize(context(), person.id, uploaded.revision);
    expect(saved.id).toBe(person.id); expect(saved.anonymizedAt).toBe(clock.now().toISOString());
    const raw = await database.forGym(gymA, async (tx) => ({ member: (await tx.select().from(members).where(eq(members.id, person.id)))[0]!,
      home: (await tx.select().from(households).where(eq(households.id, home.id)))[0]!,
      invoice: await tx.select().from(invoices).where(eq(invoices.id, invoice.id)), line: await tx.select().from(invoiceLineItems).where(eq(invoiceLineItems.id, line.id)),
      attendance: await tx.select().from(attendances).where(eq(attendances.id, attendance.id)), users: await tx.select().from(householdUsers).where(eq(householdUsers.householdId, home.id)),
      signed: (await tx.select().from(signedLinks).where(eq(signedLinks.id, signed.id)))[0]!,
      promotions: await tx.select().from(memberRanks).where(inArray(memberRanks.id, [promotion.id, otherPromotion.id])),
      waivers: await tx.select().from(waiverSignatures) }));
    expect(raw.member).toMatchObject({ email: null, phone: null, dateOfBirth: null, medicalNotes: null, emergencyContacts: [], photoKey: null, checkinCodeHash: null, status: 'cancelled' });
    expect(raw.home).toMatchObject({ name: 'Anonymized household', email: null, phone: null, address: {}, pinHash: null });
    expect(raw.invoice[0]).toEqual(invoice); expect(raw.line[0]).toEqual(line); expect(raw.attendance[0]).toEqual(attendance);
    expect(raw.users).toHaveLength(0); expect(raw.signed.revokedAt).toEqual(clock.now());
    // Promotion history is kept with its rank and date; only the notes are cleared, and only for this member.
    expect(raw.promotions).toEqual(expect.arrayContaining([{ ...promotion, notes: null }, otherPromotion]));
    // Signed waivers are erased with the member (rows and signature image); other members keep theirs.
    expect(raw.waivers.map((waiver) => waiver.id)).toEqual([otherWaiver.id]);
    expect((await (await uploadsFor(gymA)).head(signatureKey))!.deletedAt).toEqual(clock.now());
    expect((await (await uploadsFor(gymA)).head(uploaded.photoKey!))!.deletedAt).toEqual(clock.now());
    await expect(service.updateMedicalNotes(context(), person.id, { revision: saved.revision, medicalNotes: 'restore' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(photos.read(gymA, person.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('preserves another household member and shared contacts while clearing the shared PIN', async () => {
    const { home, person } = await routeFixture(gymA);
    const sibling = await factory('members', gymA, { householdId: home.id });
    await service.anonymizeMember(context(), person.id, { revision: 1 });
    expect(await service.getHousehold(gymA, home.id)).toMatchObject({ name: home.name });
    expect(await service.getMember(gymA, sibling.id)).toMatchObject({ firstName: sibling.firstName });
  });
  it.each([false, true])('revokes billing only when erasing the last member (another member: %s)', async another => {
    const { home, person } = await routeFixture(gymA);
    const customerId = 'cus_erase_' + home.id;
    await database.forGym(gymA, tx => tx.update(households).set({ stripeCustomerId: customerId }).where(eq(households.id, home.id)));
    if (another) await factory('members', gymA, { householdId: home.id });
    const card = await factory('paymentMethods', gymA, { householdId: home.id, isDefault: true });
    const revoked = await factory('paymentMethods', gymA, { householdId: home.id, revokedAt: new Date('2026-01-01Z') });
    const bill = async (householdId: string, status: string) => factory('invoices', gymA, { householdId, status,
      number: await database.forGym(gymA, tx => allocateInvoiceNumber(tx, gymA)) });
    const bills = await Promise.all(['open', 'past_due', 'paid', 'void'].map(status => bill(home.id, status)));
    const other = await routeFixture(gymA), otherCard = await factory('paymentMethods', gymA, { householdId: other.home.id, isDefault: true });
    const otherBill = await bill(other.home.id, 'open');
    const foreign = await routeFixture(gymB), foreignCard = await factory('paymentMethods', gymB, { householdId: foreign.home.id, isDefault: true });
    await expect(service.eraseMember(context(gymB), person.id, { revision: 1 })).rejects.toMatchObject({ code: 'not_found' });
    const erased = await service.eraseMember(context(), person.id, { revision: 1 });
    expect(erased.revokedCards).toEqual(another ? [] : [{ id: card.id, processorId: card.processorId }]);
    expect(erased.erasedCustomerId).toBe(another ? null : customerId);
    const state = await database.forGym(gymA, async tx => ({
      home: (await tx.select().from(households).where(eq(households.id, home.id)))[0]!,
      cards: await tx.select().from(paymentMethods).where(inArray(paymentMethods.id, [card.id, revoked.id, otherCard.id])),
      bills: await tx.select().from(invoices).where(inArray(invoices.id, [...bills.map(bill => bill.id), otherBill.id])),
    }));
    expect(state.home.stripeCustomerId).toBe(another ? customerId : null);
    expect(state.cards.find(row => row.id === card.id)).toMatchObject({ revokedAt: another ? null : clock.now(), isDefault: another });
    expect(state.cards).toEqual(expect.arrayContaining([revoked, otherCard]));
    for (const bill of bills) expect(state.bills.find(row => row.id === bill.id)!.needsReview).toBe(!another && ['open', 'past_due'].includes(bill.status));
    expect(state.bills).toContainEqual(otherBill);
    expect(await database.forGym(gymB, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.id, foreignCard.id)))).toEqual([foreignCard]);
  });
  it('cancels upcoming booked and waitlisted places under their session locks, keeps past bookings, and clears only the erased staff link', async () => {
    const { person } = await routeFixture(gymA), other = await routeFixture(gymA);
    const upcoming = { startsAt: new Date('2026-11-01T18:00:00Z'), endsAt: new Date('2026-11-01T19:00:00Z') };
    const sessions = await Promise.all([factory('classSessions', gymA, upcoming), factory('classSessions', gymA, upcoming)]);
    const bookings = await Promise.all(sessions.map((session, index) => factory('classBookings', gymA, { sessionId: session.id, memberId: person.id,
      bookedBy: userId, status: index ? 'waitlisted' : 'booked', waitlistPosition: index ? 1 : null })));
    // A session that has started (the factory default is in January) keeps its booking as history.
    const past = await factory('classBookings', gymA, { sessionId: (await factory('classSessions', gymA)).id, memberId: person.id, bookedBy: userId, status: 'booked' });
    const waiting = await factory('classBookings', gymA, { sessionId: sessions[1]!.id, memberId: other.person.id, bookedBy: userId, status: 'waitlisted', waitlistPosition: 2 });
    const profile = await factory('staffProfiles', gymA, { memberId: person.id });
    const otherProfile = await factory('staffProfiles', gymA, { memberId: other.person.id });
    // Serialize a concurrent capacity writer with erasure using the same session lock.
    await Promise.all([
      service.eraseMember(context(), person.id, { revision: 1 }),
      database.forGym(gymA, async tx => { await tx.select().from(classSessions).where(eq(classSessions.id, sessions[0]!.id)).for('update'); }),
    ]);
    const state = await database.forGym(gymA, async tx => ({
      bookings: await tx.select().from(classBookings).where(inArray(classBookings.id, [...bookings.map(row => row.id), waiting.id, past.id])),
      staff: await tx.select().from(staffProfiles).where(inArray(staffProfiles.id, [profile.id, otherProfile.id])),
    }));
    for (const booking of bookings) expect(state.bookings.find(row => row.id === booking.id)).toMatchObject({ status: 'cancelled', waitlistPosition: null, cancelledAt: clock.now() });
    expect(state.bookings).toContainEqual(waiting);
    expect(state.bookings).toContainEqual(past);
    expect(state.staff.find(row => row.id === profile.id)!.memberId).toBeNull();
    expect(state.staff).toContainEqual(otherProfile);
  });
  it.each([
    { failure: false, queued: true }, { failure: true, queued: true }, { failure: true, queued: false },
  ])('detaches all revoked cards after commit and reports only failures without a retry (%o)', async ({ failure, queued }) => {
    const { home, person } = await routeFixture(gymA);
    const cards = await Promise.all([1, 2].map(() => factory('paymentMethods', gymA, { householdId: home.id, processorId: 'pm_erase_' + uuidv7().replaceAll('-', '') })));
    const payments = new FakePayments(gymA, clock), jobs = new FakeJobs(clock);
    payments.seedCustomer({ id: 'cus_erasure', email: 'payer@example.test' });
    for (const card of cards) payments.recordPaymentMethod({ id: card.processorId, customerId: 'cus_erasure', last4: '4242', expiresMonth: 12, expiresYear: 2030 });
    const detachCard = vi.fn(async (gymId: string, processorId: string) => {
      expect(gymId).toBe(gymA);
      expect((await service.getMember(gymId, person.id)).anonymizedAt).not.toBeNull();
      expect((await database.forGym(gymA, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, home.id)))).every(card => card.revokedAt)).toBe(true);
      if (failure && processorId === cards[0]!.processorId) throw new Error('Provider unavailable');
      await payments.detachPaymentMethod(processorId);
    });
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (ctx, next) => { ctx.set('context', { principal: { kind: 'staff', gymId: gymA, userId, roles: ['owner'] }, gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() }, requestId: 'erase', clock }); await next(); });
    const errors: unknown[] = [];
    app.onError((error, ctx) => { errors.push(error); return errorHandler(error, ctx); });
    createServerRegistry({ routes: createMembersRoutes(service, uploadsFor, { detachCard, ...(queued ? { jobs } : {}) }) }).mount(app, authorize, new Set());
    const logs: unknown[] = [], previousLog = setLogSink(entry => { logs.push(JSON.parse(entry)); });
    try {
      // The erasure has committed; a queued retry makes a provider outage a logged warning, not a failed request.
      expect((await send(app, `/api/members/${person.id}/anonymize`, 'POST', { revision: 1 })).status, String(errors[0])).toBe(failure && !queued ? 500 : 200);
    } finally { setLogSink(previousLog); }
    expect(detachCard).toHaveBeenCalledTimes(2);
    expect(jobs.jobs).toHaveLength(queued ? 2 : 0);
    if (queued) expect(jobs.jobs.map(job => job.payload)).toEqual(expect.arrayContaining(cards.map(card => ({ paymentMethodId: card.id }))));
    expect(logs.filter(entry => (entry as { event?: string }).event === 'members.erasure.detach_failed')).toEqual(failure && queued ? [expect.objectContaining({ event: 'members.erasure.detach_failed', gymId: gymA, memberId: person.id, paymentMethodId: cards[0]!.id })] : []);
    expect(JSON.stringify(logs)).not.toContain('Provider unavailable');
    const stored = await database.forGym(gymA, tx => tx.select().from(paymentMethods).where(eq(paymentMethods.householdId, home.id)));
    expect(stored.every(card => card.revokedAt && !card.isDefault)).toBe(true);
  });
  it.each([
    { failure: false, queued: true }, { failure: true, queued: true }, { failure: true, queued: false },
  ])('redacts the last member\'s provider customer after commit and retries it from a queued job (%o)', async ({ failure, queued }) => {
    const { home, person } = await routeFixture(gymA), customerId = 'cus_redact_' + uuidv7().replaceAll('-', '');
    await database.forGym(gymA, tx => tx.update(households).set({ stripeCustomerId: customerId }).where(eq(households.id, home.id)));
    const payments = new FakePayments(gymA, clock), jobs = new FakeJobs(clock);
    payments.seedCustomer({ id: customerId, email: 'payer@example.test' });
    const redactCustomer = vi.fn(async (gymId: string, id: string) => {
      expect(gymId).toBe(gymA);
      // Redaction runs only after the erasure, which cleared the local customer ID, has committed.
      expect((await database.forGym(gymA, tx => tx.select().from(households).where(eq(households.id, home.id))))[0]!.stripeCustomerId).toBeNull();
      if (failure) throw new Error('Provider unavailable');
      await payments.redactCustomer(id);
    });
    const app = erasureServer({ redactCustomer, ...(queued ? { jobs } : {}) });
    const logs: unknown[] = [], previousLog = setLogSink(entry => { logs.push(JSON.parse(entry)); });
    try {
      expect((await send(app, `/api/members/${person.id}/anonymize`, 'POST', { revision: 1 })).status).toBe(failure && !queued ? 500 : 200);
    } finally { setLogSink(previousLog); }
    expect(redactCustomer).toHaveBeenCalledExactlyOnceWith(gymA, customerId);
    expect(payments.customer(customerId)).toEqual(failure ? { name: null, email: 'payer@example.test' } : { name: 'Erased member', email: null });
    expect(jobs.jobs.map(job => ({ name: job.name, payload: job.payload }))).toEqual(queued ? [{ name: redactCustomerJob, payload: { customerId } }] : []);
    expect(logs.filter(entry => (entry as { event?: string }).event === 'members.erasure.redact_failed'))
      .toEqual(failure && queued ? [expect.objectContaining({ gymId: gymA, memberId: person.id })] : []);
    expect(JSON.stringify(logs)).not.toContain(customerId);
    // The erasure's audit keeps the cleared customer ID (not personal data) as a durable record for redaction.
    expect((await database.forGym(gymA, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'household.anonymized'),
      eq(auditEvents.targetId, home.id)))))[0]!.before).toEqual({ stripeCustomerId: customerId });
    if (!queued) return;
    // The retry needs only the job's payload: the household no longer stores the customer ID. It is safe to repeat.
    const [job] = createErasureJobs({ redactCustomer: (_gymId, id) => payments.redactCustomer(id) });
    for (let run = 1; run <= 2; run++) await job!.handler(jobs.jobs[0]!.payload, { jobId: 'redact', gymId: gymA, timezone: 'UTC', attempt: run, clock });
    expect(payments.customer(customerId)).toEqual({ name: 'Erased member', email: null });
    for (const payload of [{}, { customerId: '../cus_x' }]) await expect(job!.handler(payload,
      { jobId: 'redact', gymId: gymA, timezone: 'UTC', attempt: 1, clock })).rejects.toThrow();
  });
  it('keeps the provider customer untouched while another household member remains', async () => {
    const { home, person } = await routeFixture(gymA);
    await database.forGym(gymA, tx => tx.update(households).set({ stripeCustomerId: 'cus_kept' }).where(eq(households.id, home.id)));
    await factory('members', gymA, { householdId: home.id });
    const redactCustomer = vi.fn(async () => undefined), jobs = new FakeJobs(clock);
    expect((await send(erasureServer({ redactCustomer, jobs }), `/api/members/${person.id}/anonymize`, 'POST', { revision: 1 })).status).toBe(200);
    expect(redactCustomer).not.toHaveBeenCalled();
    expect(jobs.jobs).toEqual([]);
  });
  it('cancels the erased member\'s memberships in the same transaction and leaves the household\'s others billable', async () => {
    const { home, person } = await routeFixture(gymA);
    const sibling = await factory('members', gymA, { householdId: home.id });
    const plan = await factory('plans', gymA);
    const owned = (memberId: string, status: string, extra = {}) => factory('memberships', gymA, { householdId: home.id, memberId, planId: plan.id, status, ...extra });
    const active = await owned(person.id, 'active'), trial = await owned(person.id, 'trial', { trialEndsOn: '2026-02-01' });
    const frozen = await owned(person.id, 'frozen', { resumesOn: '2026-03-01' });
    const ended = await owned(person.id, 'cancelled', { cancelledAt: new Date('2025-12-01Z') });
    const siblings = await owned(sibling.id, 'active');
    await service.anonymizeMember(context(), person.id, { revision: 1 });
    const rows = new Map((await database.forGym(gymA, (tx) => tx.select().from(memberships))).map((row) => [row.id, row]));
    for (const id of [active.id, trial.id, frozen.id])
      expect(rows.get(id)).toMatchObject({ status: 'cancelled', cancelledAt: clock.now(), resumesOn: null, revision: 2 });
    expect(rows.get(ended.id)).toEqual(ended); expect(rows.get(siblings.id)).toEqual(siblings);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, 'billing.membership.cancelled')));
    expect(audits.map((audit) => audit.targetId).sort()).toEqual([active.id, trial.id, frozen.id].sort());
  });
  it('uses immutable gym-prefixed photo keys, cleans up failed saves, and rejects foreign keys and unsafe images', async () => {
    const { person } = await routeFixture(gymA);
    const first = await photos.upload(context(), person.id, 1, png, 'image/png');
    expect(first.photoKey).toMatch(new RegExp('^' + gymA + '/members/' + person.id + '/'));
    const second = await photos.upload(context(), person.id, 2, png, 'image/png');
    expect(second.photoKey).not.toBe(first.photoKey);
    expect((await (await uploadsFor(gymA)).head(first.photoKey!))!.deletedAt).toEqual(clock.now());
    await expect(photos.upload(context(), person.id, 1, png, 'image/png')).rejects.toBeInstanceOf(RevisionConflictError);
    await expect(service.updateMember(context(), person.id, { revision: 3, photoKey: gymB + '/private' })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(photos.upload(context(), person.id, 3, Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(photos.read(gymB, person.id)).rejects.toMatchObject({ code: 'not_found' });
    const uploads = await uploadsFor(gymA), put = uploads.put.bind(uploads);
    const spy = vi.spyOn(uploads, 'put').mockImplementationOnce(async (key, body, type) => {
      const info = await put(key, body, type);
      await service.updateMember(context(), person.id, { revision: second.revision, firstName: 'Concurrent edit' });
      return info;
    });
    try { await expect(photos.upload(context(), person.id, second.revision, png, 'image/png')).rejects.toBeInstanceOf(RevisionConflictError); }
    finally { spy.mockRestore(); }
    const abandoned = (await uploads.list(`${gymA}/members/${person.id}/`)).filter((object) => object.key !== first.photoKey && object.key !== second.photoKey);
    expect(abandoned).toHaveLength(1); expect(abandoned[0]!.deletedAt).toBeDefined();
  });
  it('retires uploads left by crashes without allowing an unfinished attachment to reuse the key', async () => {
    const { person } = await routeFixture(gymA), uploads = await uploadsFor(gymA);
    const key = `${gymA}/members/${person.id}/${uuidv7()}`;
    await uploads.put(key, png, 'image/png');
    const jobClock = new TestClock(new Date(clock.now().getTime() + 3_600_001));
    const job = createMemberPhotoJobs(uploadsFor, database.forGym)[0]!;
    await job.handler(null, { gymId: gymA, timezone: 'UTC', clock: jobClock, jobId: uuidv7(), attempt: 1 });
    expect((await uploads.head(key))!.deletedAt).toBeDefined();
    await expect(service.attachPhoto(context(), person.id, 1, key)).rejects.toBeInstanceOf(RevisionConflictError);
    const current = await service.getMember(gymA, person.id);
    const photo = await photos.upload(context(), person.id, current.revision, png, 'image/png');
    await job.handler(null, { gymId: gymA, timezone: 'UTC', clock: jobClock, jobId: uuidv7(), attempt: 1 });
    expect((await uploads.head(photo.photoKey!))!.deletedAt).toBeUndefined();
    expect((await service.getMember(gymA, person.id)).photoKey).toBe(photo.photoKey);
  });
});

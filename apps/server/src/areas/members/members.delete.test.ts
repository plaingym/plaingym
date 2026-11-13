// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { announcementOptOuts, announcementRecipients, attendances, auditEvents, classBookings, householdUsers, households, invoiceLineItems,
  leadContacts, leads, memberRanks, memberTagLinks, members, memberships, signedLinks, staffProfiles, waiverSignatures, databaseCode, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { StaffRole } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import { createMembersService } from './members.js';
import { createErasureJobs, createMembersRoutes, releaseErasedFilesJob } from './members.routes.js';
import { createMemberPhotoService } from './photos.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler, respondError } from '../../core/errors.js';
import type { RequestEnvironment } from '../../core/context.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T12:00:00Z');
const gymA = uuidv7(), gymB = uuidv7();
const service = createMembersService({ scope: database.forGym, clock });
const stores = new Map<string, FakeUploads>(), uploadsFor = async (gymId: string) => {
  if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock)); return stores.get(gymId)!;
};
const photos = createMemberPhotoService(service, uploadsFor);
const context = (gymId = gymA) => ({ gymId, actor: { kind: 'system' as const } });
const queue = (jobs = new FakeJobs(clock)) => ({ jobs, timezone: 'UTC' });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
let userId: string;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); userId = (await factory('authUser', gymA)).id; });

function server(role: StaffRole, gymId = gymA) {
  const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
  app.use('*', async (ctx, next) => { ctx.set('context', { principal: { kind: 'staff', userId, gymId, roles: [role] }, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, requestId: 'delete', clock }); await next(); });
  app.onError(errorHandler);
  createServerRegistry({ routes: createMembersRoutes(service, uploadsFor, { jobs: new FakeJobs(clock), clock }) }).mount(app, authorize, new Set());
  return app;
}
const remove = (app: ReturnType<typeof server>, memberId: string, revision = 1) => app.request(`/api/members/${memberId}`,
  { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) });
const exists = async (gymId: string, memberId: string) =>
  (await database.forGym(gymId, (tx) => tx.select({ id: members.id }).from(members).where(eq(members.id, memberId)))).length === 1;
/** A member and a second member in the same household, so the household stays unless a test removes its last member. */
async function family(gymId = gymA) {
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id });
  const sibling = await factory('members', gymId, { householdId: home.id });
  return { home, person, sibling };
}
const blocked = { code: 'conflict', details: { reason: [c.memberDeleteBlockedReason] } };

describe('member deletion', () => {
  it('deletes a member without billing records and everything that is theirs, and keeps the household for its other member', async () => {
    const { home, person, sibling } = await family();
    const tag = await factory('memberTags', gymA);
    await factory('memberTagLinks', gymA, { memberId: person.id, tagId: tag.id });
    await factory('attendances', gymA, { memberId: person.id });
    const past = await factory('classSessions', gymA), upcoming = await factory('classSessions', gymA,
      { startsAt: new Date('2026-11-01T18:00:00Z'), endsAt: new Date('2026-11-01T19:00:00Z') });
    await factory('classBookings', gymA, { memberId: person.id, sessionId: past.id, bookedBy: userId });
    await factory('classBookings', gymA, { memberId: person.id, sessionId: upcoming.id, bookedBy: userId });
    const kept = await factory('classBookings', gymA, { memberId: sibling.id, sessionId: upcoming.id, bookedBy: userId });
    await factory('memberRanks', gymA, { memberId: person.id, notes: 'Promotion note' });
    const signatureKey = gymA + '/waivers/' + uuidv7();
    await (await uploadsFor(gymA)).put(signatureKey, png, 'image/png');
    await factory('waiverSignatures', gymA, { memberId: person.id, signatureImageKey: signatureKey });
    const lead = await factory('leads', gymA, { memberId: person.id });
    await factory('leadContacts', gymA, { leadId: lead.id, createdBy: userId, note: 'Called' });
    const coach = await factory('staffProfiles', gymA, { memberId: person.id });
    await factory('announcementRecipients', gymA, { memberId: person.id });
    await factory('announcementOptOuts', gymA, { memberId: person.id });
    await factory('householdUsers', gymA, { householdId: home.id, userId, scope: 'member', memberId: person.id });
    await factory('signedLinks', gymA, { householdId: home.id, memberId: person.id, purpose: 'sign_waiver' });
    const payerLink = await factory('signedLinks', gymA, { householdId: home.id, purpose: 'onboarding' });
    await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
    const uploaded = await photos.upload(context(), person.id, 1, png, 'image/png');
    const jobs = new FakeJobs(clock);

    const result = await service.deleteMember(context(), person.id, uploaded.revision, queue(jobs));
    expect(result).toEqual({ householdDeleted: false, freedSessionIds: [upcoming.id], files: [uploaded.photoKey, signatureKey] });
    const left = await database.forGym(gymA, async (tx) => {
      const count = async (rows: Promise<unknown[]>) => (await rows).length;
      return {
        rows: [await count(tx.select().from(memberTagLinks).where(eq(memberTagLinks.memberId, person.id))),
          await count(tx.select().from(attendances).where(eq(attendances.memberId, person.id))),
          await count(tx.select().from(classBookings).where(eq(classBookings.memberId, person.id))),
          await count(tx.select().from(memberRanks).where(eq(memberRanks.memberId, person.id))),
          await count(tx.select().from(waiverSignatures).where(eq(waiverSignatures.memberId, person.id))),
          await count(tx.select().from(leads).where(eq(leads.memberId, person.id))),
          await count(tx.select().from(announcementRecipients).where(eq(announcementRecipients.memberId, person.id))),
          await count(tx.select().from(announcementOptOuts).where(eq(announcementOptOuts.memberId, person.id))),
          await count(tx.select().from(householdUsers).where(eq(householdUsers.memberId, person.id))),
          await count(tx.select().from(memberships).where(eq(memberships.memberId, person.id)))],
        contacts: await tx.select().from(leadContacts).where(eq(leadContacts.leadId, lead.id)),
        links: (await tx.select({ id: signedLinks.id }).from(signedLinks).where(eq(signedLinks.householdId, home.id))).map((row) => row.id),
        coach: (await tx.select({ memberId: staffProfiles.memberId }).from(staffProfiles).where(eq(staffProfiles.id, coach.id)))[0],
        sibling: (await tx.select({ id: classBookings.id }).from(classBookings).where(eq(classBookings.id, kept.id))).length,
        home: (await tx.select({ id: households.id }).from(households).where(eq(households.id, home.id))).length,
        audits: await tx.select().from(auditEvents).where(eq(auditEvents.targetId, person.id)),
      };
    });
    expect(left.rows).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(left.contacts).toEqual([]);
    expect(left.links).toEqual([payerLink.id]);
    expect(left.coach).toEqual({ memberId: null });
    expect(left.sibling).toBe(1); expect(left.home).toBe(1);
    expect(await exists(gymA, person.id)).toBe(false); expect(await exists(gymA, sibling.id)).toBe(true);
    // The audit event names the deleted member by ID only, as an erasure's does.
    const deleted = left.audits.find((event) => event.action === 'member.deleted')!;
    expect(deleted).toMatchObject({ targetType: 'member', before: null, after: null });
    // The photo and signature image are released by the job the delete committed.
    const release = createErasureJobs({ uploadsFor }).find((job) => job.id === releaseErasedFilesJob)!;
    const queued = jobs.jobs.filter((job) => job.name === releaseErasedFilesJob);
    expect(queued).toHaveLength(1);
    await release.handler(queued[0]!.payload, { jobId: 'release', gymId: gymA, timezone: 'UTC', attempt: 1, clock });
    expect((await (await uploadsFor(gymA)).head(signatureKey))!.deletedAt).toEqual(clock.now());
    expect((await (await uploadsFor(gymA)).head(uploaded.photoKey!))!.deletedAt).toEqual(clock.now());
  });

  it('removes the household, its portal logins and its links with its last member', async () => {
    const home = await factory('households', gymA, { pinHash: 'a'.repeat(64) }), person = await factory('members', gymA, { householdId: home.id });
    await factory('householdUsers', gymA, { householdId: home.id, userId, scope: 'payer' });
    await factory('signedLinks', gymA, { householdId: home.id, purpose: 'onboarding' });
    await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
    const jobs = new FakeJobs(clock);
    expect(await service.deleteMember(context(), person.id, 1, queue(jobs))).toEqual({ householdDeleted: true, freedSessionIds: [], files: [] });
    const left = await database.forGym(gymA, async (tx) => ({
      home: await tx.select().from(households).where(eq(households.id, home.id)),
      users: await tx.select().from(householdUsers).where(eq(householdUsers.householdId, home.id)),
      links: await tx.select().from(signedLinks).where(eq(signedLinks.householdId, home.id)),
      audit: await tx.select().from(auditEvents).where(eq(auditEvents.targetId, home.id)),
    }));
    expect(left.home).toEqual([]); expect(left.users).toEqual([]); expect(left.links).toEqual([]);
    expect(left.audit.map((event) => event.action)).toContain('household.deleted');
    expect(jobs.jobs).toEqual([]);
  });

  const records: [string, (fixture: Awaited<ReturnType<typeof family>>) => Promise<unknown>, boolean][] = [
    ['an invoiced membership', async ({ home, person }) => {
      const membership = await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
      await factory('invoiceLineItems', gymA, { householdId: home.id, membershipId: membership.id, kind: 'membership' });
    }, false],
    ['a membership discount', async ({ home, person }) => {
      const membership = await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
      await factory('membershipDiscounts', gymA, { householdId: home.id, membershipId: membership.id });
    }, false],
    ['a pack purchase', ({ home, person }) => factory('classPackSales', gymA, { householdId: home.id, memberId: person.id }), false],
    ['a credit ledger entry', ({ person }) => factory('classCreditEntries', gymA, { memberId: person.id }), false],
    ['a household invoice with its last member', ({ home }) => factory('invoices', gymA, { householdId: home.id }), true],
    ['a payment with its last member', async ({ home }) => {
      const invoice = await factory('invoices', gymA, { householdId: home.id });
      await factory('payments', gymA, { invoiceId: invoice.id });
    }, true],
    ['a payment attempt with its last member', async ({ home }) => {
      const invoice = await factory('invoices', gymA, { householdId: home.id });
      await factory('paymentAttempts', gymA, { invoiceId: invoice.id });
    }, true],
    ['a saved card with its last member', ({ home }) => factory('paymentMethods', gymA, { householdId: home.id }), true],
    ['a revoked card with its last member', ({ home }) => factory('paymentMethods', gymA, { householdId: home.id, revokedAt: clock.now() }), true],
    ['a Stripe customer with its last member', ({ home }) => database.forGym(gymA, (tx) =>
      tx.update(households).set({ stripeCustomerId: 'cus_' + uuidv7().replaceAll('-', '') }).where(eq(households.id, home.id))), true],
  ];
  it.each(records)('refuses a member with %s and changes nothing', async (_name, add, alone) => {
    const fixture = await family();
    if (alone) await database.forGym(gymA, (tx) => tx.delete(members).where(eq(members.id, fixture.sibling.id)));
    await add(fixture);
    await expect(service.deleteMember(context(), fixture.person.id, 1, queue())).rejects.toMatchObject(blocked);
    expect(await exists(gymA, fixture.person.id)).toBe(true);
    const response = await remove(server('owner'), fixture.person.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { details: { reason: [c.memberDeleteBlockedReason] } } });
  });

  it('deletes a member whose household keeps its card, customer and invoices for another member', async () => {
    const { home, person, sibling } = await family();
    await factory('paymentMethods', gymA, { householdId: home.id });
    await factory('invoices', gymA, { householdId: home.id });
    await database.forGym(gymA, (tx) => tx.update(households).set({ stripeCustomerId: 'cus_keep' + uuidv7().slice(0, 8) }).where(eq(households.id, home.id)));
    const response = await remove(server('owner'), person.id);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ data: null });
    expect(await exists(gymA, person.id)).toBe(false); expect(await exists(gymA, sibling.id)).toBe(true);
  });

  it('allows managers only, refuses a stale revision, and answers 404 for another gym\'s member', async () => {
    const { person } = await family();
    for (const role of ['coach', 'front_desk'] as const) expect((await remove(server(role), person.id)).status, role).toBe(403);
    expect((await remove(server('admin'), person.id, 2)).status).toBe(409);
    const foreign = await family(gymB);
    expect((await remove(server('owner'), foreign.person.id)).status).toBe(404);
    await expect(service.deleteMember(context(), foreign.person.id, 1, queue())).rejects.toMatchObject({ code: 'not_found' });
    expect(await exists(gymB, foreign.person.id)).toBe(true);
    expect((await remove(server('admin'), person.id)).status).toBe(200);
    expect(await exists(gymA, person.id)).toBe(false);
    expect((await remove(server('admin'), person.id)).status).toBe(404);
  });

  it('refuses the delete when a charge for the member\'s membership commits while it waits', async () => {
    const { home, person } = await family();
    const membership = await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
    const invoice = await factory('invoices', gymA, { householdId: home.id });
    let open!: () => void, inserted!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; }), started = new Promise<void>((resolve) => { inserted = resolve; });
    // The charge writes its membership line and holds its transaction open.
    const charge = database.forGym(gymA, async (tx) => {
      await tx.insert(invoiceLineItems).values({ id: uuidv7(), gymId: gymA, householdId: home.id, invoiceId: invoice.id, membershipId: membership.id,
        kind: 'membership', description: 'Monthly', amountCents: 10000, currency: invoice.currency });
      inserted(); await gate;
    });
    await started;
    const deleting = service.deleteMember(context(), person.id, 1, queue()).then(() => 'deleted', (error: unknown) => error);
    // The delete waits on the membership row the charge references.
    expect(await Promise.race([deleting, new Promise((resolve) => setTimeout(() => resolve('waiting'), 200))])).toBe('waiting');
    open(); await charge;
    expect(await deleting).toMatchObject(blocked);
    expect(await exists(gymA, person.id)).toBe(true);
  });

  it('refuses a charge that starts while the delete holds the member\'s rows', async () => {
    const { home, person } = await family();
    const membership = await factory('memberships', gymA, { householdId: home.id, memberId: person.id });
    const invoice = await factory('invoices', gymA, { householdId: home.id });
    let open!: () => void, reached!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; }), held = new Promise<void>((resolve) => { reached = resolve; });
    // The delete has done all its work and holds its transaction open before committing.
    const scope: typeof database.forGym = (gymId, fn) => database.forGym(gymId, async (tx) => { const result = await fn(tx); reached(); await gate; return result; });
    const deleting = createMembersService({ scope, clock }).deleteMember(context(), person.id, 1, queue());
    await held;
    const charge = database.forGym(gymA, (tx) => tx.insert(invoiceLineItems).values({ id: uuidv7(), gymId: gymA, householdId: home.id, invoiceId: invoice.id,
      membershipId: membership.id, kind: 'membership', description: 'Monthly', amountCents: 10000, currency: invoice.currency })).then(() => 'charged', (error: unknown) => error);
    expect(await Promise.race([charge, new Promise((resolve) => setTimeout(() => resolve('waiting'), 200))])).toBe('waiting');
    open();
    expect(await deleting).toMatchObject({ householdDeleted: false });
    // The charge's reference to the deleted membership fails once the delete commits.
    expect(databaseCode(await charge)).toBe('23503');
    expect(await exists(gymA, person.id)).toBe(false);
  });
});

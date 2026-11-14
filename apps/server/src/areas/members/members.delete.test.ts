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
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { createBookingService } from '../bookings/bookings.js';
import { createStaffProfileService } from '../staff/profiles.js';
import { createBookingRoutes } from '../bookings/bookings.routes.js';

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
  createServerRegistry({ routes: createMembersRoutes(service, uploadsFor, { jobs: new FakeJobs(clock), clock,
    invitations: createPortalInvitationStore(() => database.system.db) }) }).mount(app, authorize, new Set());
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
    expect(result).toEqual({ householdId: home.id, householdDeleted: false, freedSessionIds: [upcoming.id], files: [uploaded.photoKey, signatureKey] });
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
        coach: (await tx.select({ memberId: staffProfiles.memberId, revision: staffProfiles.revision }).from(staffProfiles).where(eq(staffProfiles.id, coach.id)))[0],
        sibling: (await tx.select({ id: classBookings.id }).from(classBookings).where(eq(classBookings.id, kept.id))).length,
        home: (await tx.select({ id: households.id }).from(households).where(eq(households.id, home.id))).length,
        audits: await tx.select().from(auditEvents).where(eq(auditEvents.targetId, person.id)),
      };
    });
    expect(left.rows).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(left.contacts).toEqual([]);
    expect(left.links).toEqual([payerLink.id]);
    expect(left.coach).toEqual({ memberId: null, revision: 2 });
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
    expect(await service.deleteMember(context(), person.id, 1, queue(jobs))).toEqual({ householdId: home.id, householdDeleted: true, freedSessionIds: [], files: [] });
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

  it('answers 409 for a booking that waits on deletion, while missing and foreign members stay 404', async () => {
    const { person } = await family(), session = await factory('classSessions', gymA, {
      startsAt: new Date('2026-10-23T12:00:00Z'), endsAt: new Date('2026-10-23T13:00:00Z') });
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { reached = resolve; });
    const scope: typeof database.forGym = (gymId, fn) => database.forGym(gymId, async tx => {
      const result = await fn(tx); reached(); await gate; return result;
    });
    const deleting = createMembersService({ scope, clock }).deleteMember(context(), person.id, 1, queue());
    await held;
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (ctx, next) => { ctx.set('context', { principal: { kind: 'staff', userId, gymId: gymA, roles: ['owner'] },
      gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() }, requestId: 'booking-race', clock }); await next(); });
    app.onError(errorHandler);
    createServerRegistry({ routes: createBookingRoutes(createBookingService({ scope: database.forGym, clock })) }).mount(app, authorize, new Set());
    const booking = app.request('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: person.id, sessionId: session.id, allowWaitlist: false }) });
    try {
      await expect.poll(async () => {
        const [row] = await database.system.sql`select exists (select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "members"%for share%') as waiting`;
        return row!.waiting;
      }, { timeout: 5000 }).toBe(true);
    } finally { release(); }
    await deleting;
    expect((await booking).status).toBe(409);
    const foreign = await family(gymB), bookings = createBookingService({ scope: database.forGym, clock });
    for (const memberId of [person.id, foreign.person.id]) await expect(bookings.book({ gymId: gymA, actor: { kind: 'user', userId } },
      { memberId, sessionId: session.id, allowWaitlist: false })).rejects.toMatchObject({ code: 'not_found' });
    expect(await database.forGym(gymA, tx => tx.select().from(classBookings).where(eq(classBookings.memberId, person.id)))).toEqual([]);
  });

  it.each(['erase', 'delete'] as const)('revokes pending member invitations after %s, and household claims with the last member', async kind => {
    const invitations = createPortalInvitationStore(() => database.system.db);
    for (const last of [false, true]) {
      const { home, person, sibling } = await family();
      if (last) await service.deleteMember(context(), sibling.id, 1, queue());
      const invitee = await factory('authUser', gymA), payer = await factory('authUser', gymA);
      const invite = await database.forSystem(tx => invitations.issue(tx, gymA,
        { userId: invitee.id, householdId: home.id, memberId: person.id, scope: 'member' }, clock));
      await database.forSystem(tx => invitations.issue(tx, gymA,
        { userId: payer.id, householdId: home.id, memberId: null, scope: 'payer' }, clock));
      await database.forSystem(tx => invitations.holdClaim(tx, gymA,
        { userId: payer.id, householdId: home.id, linkId: uuidv7() }, new Date(clock.now().getTime() + 60_000), clock));
      // Even a row in another gym with identical target IDs must be untouched.
      const foreignUser = await factory('authUser', gymB);
      const foreign = await database.forSystem(tx => invitations.issue(tx, gymB,
        { userId: foreignUser.id, householdId: home.id, memberId: person.id, scope: 'member' }, clock));
      const response = kind === 'delete' ? await remove(server('owner'), person.id)
        : await server('owner').request(`/api/members/${person.id}/anonymize`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1 }) });
      expect(response.status, await response.clone().text()).toBe(200);
      await expect(invitations.inspect(gymA, invite.token, clock)).rejects.toMatchObject({ code: 'not_found' });
      expect(await invitations.outstanding(gymA, home.id, clock)).toHaveLength(last ? 0 : 1);
      const claims = await database.system.sql`select id from auth_verification where gym_id = ${gymA} and household_id = ${home.id}
        and identifier like 'portal-claim:%'`;
      expect(claims).toHaveLength(last ? 0 : 1);
      expect((await invitations.inspect(gymB, foreign.token, clock)).binding.memberId).toBe(person.id);
    }
  });

  it.each(['erase', 'delete'] as const)('invalidates an open staff profile form after %s unlinks its member', async kind => {
    const { person } = await family();
    const manager = await factory('authUser', gymA);
    await factory('staffRoles', gymA, { userId: manager.id, role: 'owner' });
    const profile = await factory('staffProfiles', gymA, { memberId: person.id });
    if (kind === 'erase') await service.eraseMember(context(), person.id, { revision: 1 }, queue());
    else await service.deleteMember(context(), person.id, 1, queue());
    const profiles = createStaffProfileService(database.forGym);
    await expect(profiles.updateProfile({ gymId: gymA, actorUserId: manager.id, clock }, profile.id,
      { revision: 1, memberId: person.id, displayName: 'Old form' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await database.forGym(gymA, tx => tx.select().from(staffProfiles).where(eq(staffProfiles.id, profile.id))))[0])
      .toMatchObject({ revision: 2, memberId: null });
  });

  it('accounts by name for every foreign key into the rows deletion removes', async () => {
    const constraints = await database.app.sql<{ name: string }[]>`select c.conname as name
      from pg_constraint c join pg_class target on target.oid = c.confrelid
      join pg_namespace ns on ns.oid = target.relnamespace
      where c.contype = 'f' and ns.nspname = 'public' and target.relname in ('members', 'households', 'memberships')`;
    // Cleared, unlinked or checked by deleteMember. A new reference must make an explicit deletion decision here.
    const handled = [
      'members_household_fk', 'household_users_household_fk', 'household_users_member_fk',
      'member_tag_links_member_fk', 'signed_links_household_fk', 'signed_links_member_fk', 'leads_member_fk',
      'memberships_household_fk', 'memberships_member_fk', 'membership_discounts_membership_fk',
      'invoices_household_fk', 'invoice_line_items_membership_fk', 'payment_methods_household_fk',
      'class_pack_sales_household_fk', 'class_pack_sales_member_fk', 'class_credit_entries_member_fk',
      'announcement_recipients_member_fk', 'announcement_opt_outs_member_fk', 'waiver_signatures_member_fk',
      'staff_profiles_member_fk', 'attendances_member_fk', 'class_bookings_member_fk', 'member_ranks_member_fk',
    ];
    expect(constraints.map(row => row.name).sort()).toEqual(handled.sort());
  });
});

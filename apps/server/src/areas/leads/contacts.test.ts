// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, leadContacts, leads, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { leadContactListResponseSchema, leadContactResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { errorHandler } from '../../core/errors.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { createMembersService } from '../members/members.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createLeadContactsService } from './contacts.js';
import { createLeadContactsRoutes } from './contacts.routes.js';
import { createLeadsService } from './list.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(), userId = uuidv7(), timezone = 'America/New_York';
  await factory('gyms', gymId, { timezone }); await factory('authUser', gymId, { id: userId });
  await factory('staffProfiles', gymId, { userId, displayName: 'Dana Desk' });
  const clock = new TestClock('2026-03-09T15:00:00Z');
  const service = createLeadContactsService({ scope: db.forGym, clock });
  return { gymId, userId, timezone, clock, service, leadsService: createLeadsService({ scope: db.forGym, clock }),
    context: { gymId, actor: { kind: 'user' as const, userId } } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function person(f: Fixture, stage?: string, overrides: Record<string, unknown> = {}) {
  const member = await factory('members', f.gymId, { status: 'prospect', ...overrides });
  if (stage) await factory('leads', f.gymId, { memberId: member.id, stage,
    wonAt: stage === 'won' ? f.clock.now() : null, lostAt: stage === 'lost' ? f.clock.now() : null });
  return member;
}
function app(f: Fixture, roles: readonly StaffRole[] = ['owner'], principal?: Principal) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId: f.gymId, timezone: f.timezone, enabledModules: new Set() }, clock: f.clock,
      requestId: 'contacts-test', principal: principal ?? { kind: 'staff', gymId: f.gymId, userId: f.userId, roles } });
    await next();
  });
  server.onError(errorHandler);
  createServerRegistry({ routes: createLeadContactsRoutes(f.service) }).mount(server, authorize, new Set());
  return server;
}
function request(server: ReturnType<typeof app>, id: string, method: 'GET' | 'POST', body?: unknown, query = '') {
  return server.request(`/api/leads/${id}/contacts${query}`, { method, ...(body === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
}
const probes = [{ method: 'GET', body: undefined }, { method: 'POST', body: { revision: 1, channel: 'call', note: 'Private note' } }] as const;
const contacts = (f: Fixture) => db.forGym(f.gymId, tx => tx.select().from(leadContacts));
const audits = (f: Fixture) => db.forGym(f.gymId, tx => tx.select().from(auditEvents));

describe('lead contact log against PostgreSQL and forced RLS', () => {
  it('moves a new lead to contacted, sets the follow-up and last contact, and audits the channel without the note', async () => {
    const f = await fixture(), member = await person(f, 'new');
    const response = await request(app(f), member.id, 'POST', { revision: 1, channel: 'call', note: ' Private note ', nextFollowUpOn: '2026-03-12' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { data } = leadContactResponseSchema.parse(await response.json());
    expect(data.lead).toMatchObject({ stage: 'contacted', revision: 2, nextFollowUpOn: '2026-03-12', lastContactedAt: f.clock.now().toISOString() });
    expect(data.contact).toMatchObject({ channel: 'call', note: 'Private note', createdBy: f.userId, createdByName: 'Dana Desk',
      occurredAt: f.clock.now().toISOString() });
    expect(await contacts(f)).toMatchObject([{ id: data.contact.id, note: 'Private note', createdBy: f.userId }]);
    const [audit] = await audits(f);
    expect(audit).toMatchObject({ action: 'lead.contacted', actorKind: 'user', actorUserId: f.userId, targetType: 'lead',
      before: { stage: 'new', nextFollowUpOn: null, revision: 1 },
      after: { stage: 'contacted', nextFollowUpOn: '2026-03-12', revision: 2, channel: 'call', contactId: data.contact.id } });
    expect(JSON.stringify(await audits(f))).not.toContain('Private note');
  });
  it('creates a row-less prospect\'s lead as contacted and leaves later stages and an unsent follow-up alone', async () => {
    const f = await fixture(), prospect = await person(f), booked = await person(f, 'trial_booked'), lost = await person(f, 'lost');
    await db.forGym(f.gymId, tx => tx.update(leads).set({ nextFollowUpOn: '2026-03-20' }).where(eq(leads.memberId, booked.id)));
    const first = await f.service.log(f.context, prospect.id, { revision: 0, channel: 'in_person' });
    expect(first.data.lead).toMatchObject({ stage: 'contacted', revision: 1, source: null });
    expect(first.data.contact.note).toBeNull();
    const kept = await f.service.log(f.context, booked.id, { revision: 1, channel: 'text', note: '' });
    expect(kept.data.lead).toMatchObject({ stage: 'trial_booked', nextFollowUpOn: '2026-03-20', revision: 2 });
    expect(kept.data.contact.note).toBeNull();
    const cleared = await f.service.log(f.context, booked.id, { revision: 2, channel: 'email', nextFollowUpOn: null });
    expect(cleared.data.lead.nextFollowUpOn).toBeNull();
    expect((await f.service.log(f.context, lost.id, { revision: 1, channel: 'other' })).data.lead.stage).toBe('lost');
    expect((await f.leadsService.read(f.gymId, prospect.id)).data.lastContactedAt).toBe(f.clock.now().toISOString());
  });
  it('conflicts on a stale revision or a racing first contact and writes nothing more', async () => {
    const f = await fixture(), member = await person(f), server = app(f);
    const racing = await Promise.all([0, 1].map(() => request(server, member.id, 'POST', { revision: 0, channel: 'call' })));
    expect(racing.map(row => row.status).sort()).toEqual([200, 409]);
    expect((await request(server, member.id, 'POST', { revision: 0, channel: 'call' })).status).toBe(409);
    expect((await request(server, member.id, 'POST', { revision: 5, channel: 'call' })).status).toBe(409);
    expect(await contacts(f)).toHaveLength(1);
    expect((await audits(f)).map(row => row.action)).toEqual(['lead.contacted']);
  });
  it('rejects invalid bodies: an unknown channel, an over-long note and a bad date', async () => {
    const f = await fixture(), member = await person(f, 'new'), server = app(f);
    for (const body of [{ revision: 1, channel: 'fax' }, { revision: 1, channel: 'call', note: 'x'.repeat(2001) },
      { revision: 1, channel: 'call', nextFollowUpOn: '2026-02-30' }, { revision: 1 }])
      expect((await request(server, member.id, 'POST', body)).status).toBe(400);
    // 2,000 four-byte code points fit the body limit and the database's character count.
    expect((await request(server, member.id, 'POST', { revision: 1, channel: 'text', note: '😀'.repeat(2000) })).status).toBe(200);
    // A client that escapes every non-ASCII character sends each as a \u surrogate pair: about 24,000 bytes, still within the limit.
    const escaped = JSON.stringify({ revision: 2, channel: 'text', note: '😀'.repeat(2000) })
      .replace(/[\u0080-￿]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    expect(escaped.length).toBeGreaterThan(24_000);
    expect((await server.request(`/api/leads/${member.id}/contacts`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: escaped })).status).toBe(200);
  });
  it('lists contacts newest first with paging and a total, and an empty page for a row-less lead', async () => {
    const f = await fixture(), member = await person(f), server = app(f);
    expect(leadContactListResponseSchema.parse(await (await request(server, member.id, 'GET')).json()))
      .toEqual({ data: [], pagination: { limit: 50, offset: 0, total: 0 } });
    for (let revision = 0; revision < 3; revision++) {
      await f.service.log(f.context, member.id, { revision, channel: 'call', note: 'Note ' + revision });
      f.clock.advance(60_000);
    }
    const response = await request(server, member.id, 'GET', undefined, '?limit=2&offset=1');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const page = leadContactListResponseSchema.parse(await response.json());
    expect(page.data.map(row => row.note)).toEqual(['Note 1', 'Note 0']);
    expect(page.pagination).toEqual({ limit: 2, offset: 1, total: 3 });
    expect(page.data[0]).toMatchObject({ createdBy: f.userId, createdByName: 'Dana Desk' });
    expect((await request(server, member.id, 'GET', undefined, '?limit=101')).status).toBe(400);
  });
  it('shows no name for a staff user without a staff profile', async () => {
    const f = await fixture(), member = await person(f), other = uuidv7();
    await factory('authUser', f.gymId, { id: other });
    const logged = await f.service.log({ gymId: f.gymId, actor: { kind: 'user', userId: other } }, member.id, { revision: 0, channel: 'call' });
    expect(logged.data.contact).toMatchObject({ createdBy: other, createdByName: null });
    expect((await f.service.list(f.gymId, member.id)).data[0]?.createdByName).toBeNull();
  });
  it('rolls back the lead, the contact and the audit together when the transaction fails', async () => {
    const f = await fixture(), member = await person(f, 'new');
    const service = createLeadContactsService({ clock: f.clock, scope: (gymId, fn) => db.forGym(gymId, async tx => {
      await fn(tx); throw new Error('fail after audit');
    }) });
    await expect(service.log(f.context, member.id, { revision: 1, channel: 'call' })).rejects.toThrow('fail after audit');
    expect((await f.leadsService.read(f.gymId, member.id)).data).toMatchObject({ stage: 'new', revision: 1 });
    expect(await contacts(f)).toEqual([]); expect(await audits(f)).toEqual([]);
  });
  it.each(staffRoles)('allows owners, admins and front desk and refuses coaches on both routes: %s', async role => {
    const f = await fixture(), server = app(f, [role]);
    for (const probe of probes) {
      const member = await person(f, 'new');
      const response = await request(server, member.id, probe.method, probe.body);
      expect(response.status).toBe(role === 'coach' ? 403 : 200);
    }
    if (role === 'coach') expect(await contacts(f)).toEqual([]);
  });
  it('returns 404 for a foreign-gym, erased, missing or ordinary non-lead member, writing nothing', async () => {
    const f = await fixture(), b = await fixture(), server = app(f);
    const foreign = await person(b, 'new');
    await b.service.log(b.context, foreign.id, { revision: 1, channel: 'call', note: 'Gym B note' });
    const erased = await person(f, 'new', { anonymizedAt: f.clock.now() });
    const ordinary = await person(f, undefined, { status: 'active' });
    for (const memberId of [foreign.id, erased.id, ordinary.id, uuidv7()]) for (const probe of probes) {
      const response = await request(server, memberId, probe.method, probe.body);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Gym B note');
    }
    expect(await contacts(f)).toEqual([]);
    expect((await contacts(b)).map(row => row.note)).toEqual(['Gym B note']);
  });
  it('makes an actually erased member\'s contacts unreadable and removes them', async () => {
    const f = await fixture(), member = await person(f, 'new'), server = app(f);
    await f.service.log(f.context, member.id, { revision: 1, channel: 'call', note: 'Private note' });
    await createMembersService({ scope: db.forGym, clock: f.clock }).eraseMember(f.context, member.id, { revision: 1 }, { jobs: new FakeJobs(f.clock), timezone: 'UTC' });
    for (const probe of probes)
      expect((await request(server, member.id, probe.method, probe.body && { ...probe.body, revision: 2 })).status).toBe(404);
    expect(await contacts(f)).toEqual([]);
  });
  it('denies anonymous, member, kiosk and foreign staff principals on both routes', async () => {
    const f = await fixture(), member = await person(f, 'new');
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId: f.userId, scope: { gymId: f.gymId, householdId: member.householdId, role: 'payer' } },
      { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() },
      { kind: 'staff', gymId: uuidv7(), userId: f.userId, roles: ['owner'] }];
    for (const principal of principals) {
      const server = app(f, [], principal), status = principal.kind === 'anonymous' ? 401 : 403;
      for (const probe of probes) expect((await request(server, member.id, probe.method, probe.body)).status).toBe(status);
    }
    expect(await contacts(f)).toEqual([]);
  });
});

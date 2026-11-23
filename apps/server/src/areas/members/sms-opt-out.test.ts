// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, asc, eq, like } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { StaffRole } from '@plaingym/shared';
import * as c from '@plaingym/shared/contracts';
import type { ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler, respondError } from '../../core/errors.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeSms, MemberSms, SmsDeliveryError } from '../../infra/sms/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import type { SmsResolver } from '../settings/sms.js';
import { autoMatch, csvLine, parseCsv } from '../imports/pipeline.csv.js';
import { createImportPipeline } from '../imports/pipeline.js';
import { createMembersService } from './members.js';
import { createMembersRoutes } from './members.routes.js';
import { readSmsOptedOut } from './sms-opt-out.js';

const database = useTestDatabase(), factory = createFactories(database), scope = database.forGym;
const clock = new TestClock('2026-11-20T18:00:00Z');
const service = createMembersService({ scope, clock });
const stores = new Map<string, FakeUploads>();
const uploadsFor = async (gymId: string) => {
  if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock)); return stores.get(gymId)!;
};
// Records store the normalized number with the phone, so recording consent never counts as a number change.
const raw = '202-555-0123', normalized = '+12025550123', digits = '2025550123', stored = { phone: raw, phoneE164: normalized };
const context = (gymId: string) => ({ gymId, actor: { kind: 'system' as const } });
type Kind = 'member' | 'household';

async function gym() {
  const gymId = uuidv7();
  await factory('gyms', gymId, { name: 'Test Gym', address: { country: 'US' }, timezone: 'America/Los_Angeles', memberSmsEnabled: true, smsDailyCap: 1000 });
  return gymId;
}
/** A record with this phone and staff-recorded notices consent, written through the members service. */
async function consented(gymId: string, type: Kind) {
  const home = await factory('households', gymId, stored);
  if (type === 'household') {
    const on = await service.changeHouseholdSmsConsent(context(gymId), home.id, { consent: true, revision: home.revision });
    return { id: home.id, revision: on.revision };
  }
  const person = await factory('members', gymId, { householdId: home.id, ...stored });
  const on = await service.changeMemberSmsConsent(context(gymId), person.id, { kind: 'notices', consent: true, revision: person.revision });
  return { id: person.id, revision: on.revision };
}
/** The provider refuses a notice because the number replied STOP; MemberSms clears and audits every record with it. */
async function replyStop(gymId: string, type: Kind, id: string) {
  const sms = new FakeSms();
  const resolver: SmsResolver = { async resolve(gym) { return { gymId: gym, name: 'Test Gym', sms }; }, async configured() { return true; },
    async status() { return { source: 'gym', unreadable: false }; } };
  sms.respondNext(new SmsDeliveryError('not_accepted', 'recipient_opted_out'));
  const sender = new MemberSms({ gymId, memberIds: type === 'member' ? [id] : [], householdIds: type === 'household' ? [id] : [], kind: 'notices',
    resolver, settings: createGymSettingsAccessor({ scope }), scope, clock, logSuppression: () => undefined });
  await expect(sender.sendSms({ to: normalized, body: 'Notice' })).rejects.toMatchObject({ reason: 'recipient_opted_out' });
  return clock.now().toISOString();
}
const read = (gymId: string, type: Kind, id: string) => scope(gymId, tx => readSmsOptedOut(tx, type, id));
const revisionOf = async (gymId: string, type: Kind, id: string) =>
  (type === 'member' ? await service.getMember(gymId, id) : await service.getHousehold(gymId, id)).revision;
const numberChanges = (gymId: string) => scope(gymId, tx => tx.select().from(auditEvents)
  .where(like(auditEvents.action, '%.sms_number_changed')).orderBy(asc(auditEvents.id)));
const expectNoPhone = (rows: unknown) => { for (const value of [raw, normalized, digits]) expect(JSON.stringify(rows)).not.toContain(value); };

describe.each(['member', 'household'] as const)('the %s opted-out date', type => {
  it('is the time of an opt-out after a consent recording', async () => {
    const gymId = await gym(), record = await consented(gymId, type);
    clock.advance(60_000); const at = await replyStop(gymId, type, record.id);
    expect(await read(gymId, type, record.id)).toBe(at);
    const sms = type === 'member' ? (await service.getMember(gymId, record.id)).sms : (await service.getHousehold(gymId, record.id)).sms;
    expect(sms).toMatchObject({ notices: null, optedOutAt: at });
  });
  it('ends when consent is recorded again', async () => {
    const gymId = await gym(), record = await consented(gymId, type);
    clock.advance(60_000); await replyStop(gymId, type, record.id); clock.advance(60_000);
    const revision = await revisionOf(gymId, type, record.id);
    if (type === 'member') await service.changeMemberSmsConsent(context(gymId), record.id, { kind: 'notices', consent: true, revision });
    else await service.changeHouseholdSmsConsent(context(gymId), record.id, { consent: true, revision });
    expect(await read(gymId, type, record.id)).toBeNull();
  });
  it('ends when staff change the number, with one number-changed audit holding no phone', async () => {
    const gymId = await gym(), record = await consented(gymId, type);
    clock.advance(60_000); await replyStop(gymId, type, record.id); clock.advance(60_000);
    const revision = await revisionOf(gymId, type, record.id);
    if (type === 'member') await service.updateMember(context(gymId), record.id, { phone: '202-555-0199', revision });
    else await service.updateHousehold(context(gymId), record.id, { phone: '202-555-0199', revision });
    expect(await read(gymId, type, record.id)).toBeNull();
    const changes = await numberChanges(gymId);
    expect(changes).toEqual([expect.objectContaining({ action: type + '.sms_number_changed', targetType: type, targetId: record.id,
      actorKind: 'system', occurredAt: clock.now(), before: null, after: { changeSource: 'staff' } })]);
    expectNoPhone(changes); expect(JSON.stringify(changes)).not.toContain('5550199');
  });
  it('is null after a staff withdrawal with no opt-out', async () => {
    const gymId = await gym(), record = await consented(gymId, type);
    clock.advance(60_000);
    if (type === 'member') await service.changeMemberSmsConsent(context(gymId), record.id, { kind: 'notices', consent: false, revision: record.revision });
    else await service.changeHouseholdSmsConsent(context(gymId), record.id, { consent: false, revision: record.revision });
    expect(await read(gymId, type, record.id)).toBeNull();
  });
  it('is null with no audits', async () => {
    const gymId = await gym(), home = await factory('households', gymId, stored);
    const id = type === 'household' ? home.id : (await factory('members', gymId, { householdId: home.id, ...stored })).id;
    expect(await read(gymId, type, id)).toBeNull();
    expect((type === 'member' ? await service.getMember(gymId, id) : await service.getHousehold(gymId, id)).sms.optedOutAt).toBeNull();
  });
  it('resolves audits at the same time by ID', async () => {
    const gymId = await gym(), occurredAt = clock.now(), [optedOut, recorded] = [uuidv7(), uuidv7()].sort();
    const write = (id: string, targetId: string, action: string) => scope(gymId, tx => tx.insert(auditEvents).values({ id, gymId,
      actorKind: 'system', action: type + action, targetType: type, targetId, occurredAt }));
    // The opt-out has the higher ID for the first record and the lower ID for the second.
    const stopped = uuidv7(), reconsented = uuidv7();
    await write(optedOut!, reconsented, '.sms_opted_out'); await write(recorded!, reconsented, '.sms_consent_changed');
    const [lower, higher] = [uuidv7(), uuidv7()].sort();
    await write(lower!, stopped, '.sms_number_changed'); await write(higher!, stopped, '.sms_opted_out');
    expect(await read(gymId, type, stopped)).toBe(occurredAt.toISOString());
    expect(await read(gymId, type, reconsented)).toBeNull();
  });
  it('ignores another record and another target type', async () => {
    const gymId = await gym(), record = await consented(gymId, type), other = uuidv7();
    await scope(gymId, tx => tx.insert(auditEvents).values({ gymId, actorKind: 'system', action: type + '.sms_opted_out',
      targetType: type, targetId: other, occurredAt: clock.now() }));
    expect(await read(gymId, type, record.id)).toBeNull();
    const wrongType = type === 'member' ? 'household' : 'member';
    await scope(gymId, tx => tx.insert(auditEvents).values({ gymId, actorKind: 'system', action: type + '.sms_opted_out',
      targetType: wrongType, targetId: record.id, occurredAt: clock.now() }));
    expect(await read(gymId, type, record.id)).toBeNull();
  });
});

describe('staff routes', () => {
  function server(gymId: string, role: StaffRole = 'owner') {
    const principal: Principal = { kind: 'staff', userId: uuidv7(), gymId, roles: [role] };
    const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
    app.use('*', async (ctx, next) => { ctx.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, requestId: 'test', clock }); await next(); });
    app.onError(errorHandler);
    createServerRegistry({ routes: createMembersRoutes(service, uploadsFor, { jobs: new FakeJobs(clock) }) }).mount(app, authorize, new Set());
    return app;
  }
  it('return the opted-out date on single reads only, and 404 to another gym', async () => {
    const gymA = await gym(), gymB = await gym();
    const person = await consented(gymA, 'member'), home = await consented(gymA, 'household');
    clock.advance(60_000); const at = await replyStop(gymA, 'member', person.id);
    const app = server(gymA), other = server(gymB);
    const member = c.memberResponseSchema.parse(await (await app.request(`/api/members/${person.id}`)).json()).data;
    expect(member.sms.optedOutAt).toBe(at);
    const household = c.householdResponseSchema.parse(await (await app.request(`/api/households/${home.id}`)).json()).data;
    // The provider cleared every record with the number, so the household replied STOP at the same time.
    expect(household.sms.optedOutAt).toBe(at);
    const people = c.memberListResponseSchema.parse(await (await app.request('/api/members?limit=50&offset=0')).json()).data;
    expect(people.length).toBeGreaterThan(0);
    for (const row of people) expect(row.sms).not.toHaveProperty('optedOutAt');
    const homes = await (await app.request('/api/households?limit=50&offset=0')).json() as { data: { sms: object }[] };
    expect(homes.data.length).toBeGreaterThan(0);
    for (const row of homes.data) expect(row.sms).not.toHaveProperty('optedOutAt');
    expect((await other.request(`/api/members/${person.id}`)).status).toBe(404);
    expect((await other.request(`/api/households/${home.id}`)).status).toBe(404);
    // Gym B's own read can't see gym A's audits even for a record ID it names.
    expect(await read(gymB, 'member', person.id)).toBeNull();
  });
});

describe('number-changed audits', () => {
  it('are written once per changed number by staff member and household edits, and never for a reformatted number', async () => {
    const gymId = await gym(), person = await consented(gymId, 'member'), home = await consented(gymId, 'household');
    const formatted = await service.updateMember(context(gymId), person.id, { phone: '(202) 555-0123', revision: person.revision });
    await service.updateHousehold(context(gymId), home.id, { phone: '(202) 555-0123', revision: home.revision });
    expect(await numberChanges(gymId)).toEqual([]);
    await service.updateMember(context(gymId), person.id, { phone: 'not a phone', revision: formatted.revision });
    const household = await service.getHousehold(gymId, home.id);
    await service.updateHousehold(context(gymId), home.id, { phone: '202-555-0199', revision: household.revision });
    const changes = await numberChanges(gymId);
    expect(changes.map(row => [row.action, row.targetId, row.after])).toEqual([
      ['member.sms_number_changed', person.id, { changeSource: 'staff' }],
      ['household.sms_number_changed', home.id, { changeSource: 'staff' }]]);
    // Each follows the consent-cleared audit of the same change.
    for (const change of changes) {
      const cleared = await scope(gymId, tx => tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, change.targetId),
        like(auditEvents.action, '%.sms_consent_changed'))).orderBy(asc(auditEvents.id)));
      expect(cleared.at(-1)!.id < change.id).toBe(true);
    }
    expectNoPhone(changes); expect(JSON.stringify(changes)).not.toContain('5550199');
  });
  it('are written once per changed number by a people import', async () => {
    const gymId = await gym();
    const home = await factory('households', gymId, stored);
    const person = await factory('members', gymId, { householdId: home.id, firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test', ...stored,
      smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' });
    const pipeline = createImportPipeline({ scope, clock, jobs: new FakeJobs(clock), uploadsFor });
    const actor = { gymId, actor: { kind: 'system' } } as const;
    for (const phone of ['202 555 0123', '202-555-0177']) {
      const csv = csvLine(['First Name', 'Last Name', 'Email', 'Phone']) + csvLine(['Jo', 'Fields', 'jo@example.test', phone]);
      const upload = await pipeline.upload(actor, new File([csv], 'members.csv'));
      const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'people', mapping: autoMatch(parseCsv(csv).columns), duplicatePolicy: 'update' };
      const job = await pipeline.start(actor, { ...plan, dryRun: false }, 'UTC');
      await pipeline.run(gymId, job.id);
      expect(await pipeline.get(gymId, job.id)).toMatchObject({ status: 'succeeded', committedRows: 1 });
    }
    const changes = await numberChanges(gymId);
    expect(changes.map(row => [row.action, row.targetId, row.after])).toEqual([['member.sms_number_changed', person.id, { changeSource: 'import' }]]);
    expectNoPhone(changes); expect(JSON.stringify(changes)).not.toContain('5550177');
  });
});

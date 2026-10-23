// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { attendances, auditEvents, classSessions, households, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, staffRoles } from '@plaingym/shared';
import { kioskFamilyCheckinResponseSchema, kioskLookupResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { createServerRegistry } from '../../../core/registry.js';
import { errorHandler, respondError } from '../../../core/errors.js';
import type { Principal, RequestEnvironment } from '../../../core/context.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { authorize } from '../../staff/auth.permissions.js';
import { hashHouseholdPin } from '../../members/pin.js';
import { createKioskCheckin } from './checkin.js';
import { createKioskCheckinRoutes } from './standing.routes.js';
import { createStandingChecks } from './standing.js';
import { createApp } from '../../../core/app.js';
import { createKioskAuthMiddleware } from '../devices.auth.js';
import { createKioskDeviceService } from '../devices.js';

const database = useTestDatabase(), factory = createFactories(database), clock = new TestClock('2026-10-22T18:00:00Z');
// Gym C publishes a waiver, which applies to every member there, so it stays separate from A and B.
const gymA = uuidv7(), gymB = uuidv7(), gymC = uuidv7();
const secrets = new Map([[gymA, new Uint8Array(32).fill(7)], [gymB, new Uint8Array(32).fill(9)], [gymC, new Uint8Array(32).fill(11)]]);
const stores = new Map<string, FakeUploads>(), uploadsFor = async (gymId: string) => {
  if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock)); return stores.get(gymId)!;
};
const service = createKioskCheckin({ scope: database.forGym, clock, pinSecret: async (gymId) => secrets.get(gymId)!, uploadsFor });
const at = (minutes: number) => new Date(clock.now().getTime() + minutes * 60_000);
let deviceA: string, deviceB: string;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB); await factory('gyms', gymC);
  deviceA = (await factory('kioskDevices', gymA)).id; deviceB = (await factory('kioskDevices', gymB)).id;
});
async function family(gymId = gymA, name = 'Rivera ' + uuidv7().slice(-6), pin = '0042') {
  const id = uuidv7();
  await factory('households', gymId, { id, name, pinHash: hashHouseholdPin(secrets.get(gymId)!, gymId, id, pin) });
  const parent = await factory('members', gymId, { householdId: id, firstName: 'Dana', lastName: name.split(' ')[0]!, status: 'active' });
  const child = await factory('members', gymId, { householdId: id, firstName: 'Kai', lastName: name.split(' ')[0]!, status: 'trial' });
  return { id, name, pin, parent, child };
}
const visits = (gymId: string, memberId: string) => database.forGym(gymId, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, memberId)));

describe('kiosk name and PIN check-in', () => {
  it('completes repeated household selections through the real device limiter', async () => {
    const devices = createKioskDeviceService({ scope: database.forGym, clock });
    const issued = await devices.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Busy tablet' });
    const app = createApp({ clock, authorize,
      resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: gymA, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
      session: createKioskAuthMiddleware({ service: devices }), contributions: { routes: createKioskCheckinRoutes(service) },
    });
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + issued.token }, body: JSON.stringify(body) });
    for (let i = 0; i < 4; i++) {
      const home = await family(gymA, 'Busy' + uuidv7()), credentials = { name: home.name, pin: home.pin };
      expect((await post('/api/kiosk/lookup', credentials)).status).toBe(200);
      expect((await post('/api/kiosk/checkin', { ...credentials, checkins: [{ memberId: home.parent.id }] })).status).toBe(200);
      const result = await post('/api/kiosk/checkin', { ...credentials, checkins: [{ memberId: home.parent.id, sessionId: null }] });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ data: [{ status: 'checked_in' }] });
      expect(await visits(gymA, home.parent.id)).toHaveLength(1);
    }
  });
  it('finds one household by name and PIN, showing only first names, last initials and photo links', async () => {
    const home = await family();
    const photoKey = gymA + '/members/' + home.parent.id + '/' + uuidv7();
    await (await uploadsFor(gymA)).put(photoKey, new Uint8Array([1, 2, 3]), 'image/png');
    await database.forGym(gymA, (tx) => tx.update(members).set({ photoKey }).where(eq(members.id, home.parent.id)));
    const result = kioskLookupResponseSchema.parse({ data: await service.lookup(gymA, { name: home.name, pin: home.pin }) }).data;
    expect(result.status).toBe('select_member');
    if (result.status !== 'select_member') return;
    expect(result.members.map((member) => member.firstName)).toEqual(['Dana', 'Kai']);
    expect(result.members.every((member) => member.lastInitial === 'R')).toBe(true);
    expect(result.members[0]!.photoUrl).toEqual(expect.any(String)); expect(result.members[1]!.photoUrl).toBeNull();
    // A member's own name finds the household too, with or without the last name.
    expect((await service.lookup(gymA, { name: 'kai ' + home.name.slice(0, 3), pin: home.pin })).status).toBe('select_member');
    for (const attempt of [{ name: home.name, pin: '0043' }, { name: 'Nobody', pin: home.pin }])
      expect(await service.lookup(gymA, attempt)).toEqual({ status: 'see_front_desk' });
  });
  it('never matches another gym, and sends households sharing a name and PIN to the front desk', async () => {
    const name = 'Okafor ' + uuidv7().slice(-6);
    await family(gymB, name);
    expect(await service.lookup(gymA, { name, pin: '0042' })).toEqual({ status: 'see_front_desk' });
    const own = await family(gymA, name);
    expect((await service.lookup(gymA, { name, pin: '0042' })).status).toBe('select_member');
    await family(gymA, name);
    expect(await service.lookup(gymA, { name, pin: '0042' })).toEqual({ status: 'see_front_desk' });
    // The household's own members stay unreachable from gym B's kiosk.
    expect(await service.checkin(gymB, deviceB, { name, pin: '0042', checkins: [{ memberId: own.parent.id, sessionId: null }] }))
      .toEqual([{ status: 'see_front_desk' }]);
    expect(await visits(gymA, own.parent.id)).toHaveLength(0);
  });
  it('checks in a family for open mat, keeping every tap, and audits the device', async () => {
    const home = await family();
    const request = { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: null }, { memberId: home.child.id, sessionId: null }] };
    const results = kioskFamilyCheckinResponseSchema.parse({ data: await service.checkin(gymA, deviceA, request) }).data;
    expect(results.map((result) => result.status)).toEqual(['checked_in', 'checked_in']);
    await service.checkin(gymA, deviceA, request);
    const rows = await visits(gymA, home.parent.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === 'kiosk' && row.kind === 'open_mat' && row.sessionId === null)).toBe(true);
    const audits = await database.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, rows[0]!.id)));
    expect(audits[0]).toMatchObject({ actorKind: 'device', actorDeviceId: deviceA, actorUserId: null });
  });
  it('picks a booked class, prompts between classes running now, and never checks in twice', async () => {
    const home = await family(), user = await factory('authUser', gymA);
    const running = await factory('classSessions', gymA, { name: 'Fundamentals', startsAt: at(-10), endsAt: at(50) });
    const soon = await factory('classSessions', gymA, { name: 'Advanced', startsAt: at(30), endsAt: at(90) });
    await factory('classSessions', gymA, { name: 'Later', startsAt: at(120), endsAt: at(180) });
    await factory('classSessions', gymA, { name: 'Cancelled', startsAt: at(-5), endsAt: at(55), status: 'cancelled' });
    await factory('classBookings', gymA, { memberId: home.child.id, sessionId: soon.id, bookedBy: user.id });
    const credentials = { name: home.name, pin: home.pin };
    const first = await service.checkin(gymA, deviceA, { ...credentials, checkins: [{ memberId: home.parent.id }, { memberId: home.child.id }] });
    expect(first[0]).toMatchObject({ status: 'select_session', sessions: [{ id: running.id }, { id: soon.id }] });
    expect(first[1]).toMatchObject({ status: 'checked_in' });
    expect((await visits(gymA, home.child.id))[0]).toMatchObject({ sessionId: soon.id, source: 'kiosk' });
    expect(await service.checkin(gymA, deviceA, { ...credentials, checkins: [{ memberId: home.parent.id, sessionId: running.id }] })).toMatchObject([{ status: 'checked_in' }]);
    expect(await service.checkin(gymA, deviceA, { ...credentials, checkins: [{ memberId: home.parent.id, sessionId: running.id }] })).toMatchObject([{ status: 'already_checked_in' }]);
    // A session that isn't open for check-in re-prompts instead of recording.
    const later = await service.checkin(gymA, deviceA, { ...credentials, checkins: [{ memberId: home.parent.id, sessionId: uuidv7() }] });
    expect(later[0]).toMatchObject({ status: 'select_session' });
    expect(await visits(gymA, home.parent.id)).toHaveLength(1);
  });
  it('offers only open mat when no class is running', async () => {
    const quiet = createKioskCheckin({ scope: database.forGym, clock: new TestClock('2026-10-25T03:00:00Z'), pinSecret: async (gymId) => secrets.get(gymId)! });
    const home = await family();
    expect(await quiet.checkin(gymA, deviceA, { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id }] }))
      .toMatchObject([{ status: 'select_session', sessions: [] }]);
  });
  it('sends inactive members, missing waivers and members outside the household to the front desk', async () => {
    const home = await family(gymC), other = await family(gymC), device = (await factory('kioskDevices', gymC)).id;
    const frozen = await factory('members', gymC, { householdId: home.id, firstName: 'Frozen', lastName: 'Rivera', status: 'frozen' });
    const template = await factory('waiverTemplates', gymC, { name: 'Liability' });
    await factory('waiverTemplates', gymC, { name: template.name, version: 2 });
    await factory('waiverSignatures', gymC, { memberId: home.parent.id, templateId: template.id });
    const results = await service.checkin(gymC, device, { name: home.name, pin: home.pin, checkins: [
      { memberId: home.parent.id, sessionId: null }, { memberId: frozen.id, sessionId: null }, { memberId: other.parent.id, sessionId: null }] });
    // Only version 1 is signed, so the current waiver (version 2) is missing.
    expect(results).toEqual([{ status: 'see_front_desk' }, { status: 'see_front_desk' }, { status: 'see_front_desk' }]);
    expect(JSON.stringify(results)).not.toMatch(/waiver|inactive|frozen|billing/);
    for (const memberId of [home.parent.id, frozen.id, other.parent.id]) expect(await visits(gymC, memberId)).toHaveLength(0);
    expect(await service.memberStanding(gymC, home.parent.id)).toEqual({ memberId: home.parent.id, status: 'front_desk', reasons: ['missing_waiver'] });
    expect(await service.memberStanding(gymC, frozen.id)).toMatchObject({ status: 'front_desk', reasons: expect.arrayContaining(['inactive']) });
    await expect(service.memberStanding(gymB, home.parent.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('fails closed without the gym key', async () => {
    const unconfigured = createKioskCheckin({ scope: database.forGym, clock });
    const home = await family();
    await expect(unconfigured.lookup(gymA, { name: home.name, pin: home.pin })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('cannot use one household PIN to check in another household, even with the same PIN', async () => {
    const home = await family(), other = await family();
    expect(await service.checkin(gymA, deviceA, { name: home.name, pin: home.pin,
      checkins: [{ memberId: other.parent.id, sessionId: null }] })).toEqual([{ status: 'see_front_desk' }]);
    expect(await visits(gymA, other.parent.id)).toHaveLength(0);
    const [saved] = await database.forGym(gymA, (tx) => tx.select({ pinHash: households.pinHash }).from(households).where(eq(households.id, home.id)));
    const pinHash = saved!.pinHash;
    await database.forGym(gymA, (tx) => tx.update(households).set({ pinHash }).where(eq(households.id, other.id)));
    expect(await service.lookup(gymA, { name: other.name, pin: home.pin })).toEqual({ status: 'see_front_desk' });
    const foreign = await family(gymB);
    await database.forGym(gymB, (tx) => tx.update(households).set({ pinHash }).where(eq(households.id, foreign.id)));
    expect(await service.lookup(gymB, { name: foreign.name, pin: home.pin })).toEqual({ status: 'see_front_desk' });
  });
  it('rechecks credentials and household membership rather than trusting a cached roster', async () => {
    const home = await family(), other = await family();
    expect((await service.lookup(gymA, { name: home.name, pin: home.pin })).status).toBe('select_member');
    await database.forGym(gymA, (tx) => tx.update(members).set({ householdId: other.id }).where(eq(members.id, home.child.id)));
    expect(await service.checkin(gymA, deviceA, { name: home.name, pin: home.pin,
      checkins: [{ memberId: home.child.id, sessionId: null }] })).toEqual([{ status: 'see_front_desk' }]);
    await database.forGym(gymA, (tx) => tx.update(households).set({ pinHash: null }).where(eq(households.id, home.id)));
    expect(await service.checkin(gymA, deviceA, { name: home.name, pin: home.pin,
      checkins: [{ memberId: home.parent.id, sessionId: null }] })).toEqual([{ status: 'see_front_desk' }]);
    expect(await visits(gymA, home.child.id)).toHaveLength(0);
  });
  it('deduplicates simultaneous session check-ins through the attendance service', async () => {
    const home = await family();
    const session = await factory('classSessions', gymA, { startsAt: at(-5), endsAt: at(45) });
    const input = { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: session.id }] };
    const results = await Promise.all(Array.from({ length: 6 }, () => service.checkin(gymA, deviceA, input)));
    expect(results.flat().every((result) => ['checked_in', 'already_checked_in'].includes(result.status))).toBe(true);
    expect(await visits(gymA, home.parent.id)).toHaveLength(1);
  });
  it('requires the current waiver, accepts its signature, and never revives a retired waiver', async () => {
    const gymId = uuidv7(); secrets.set(gymId, new Uint8Array(32).fill(13));
    await factory('gyms', gymId);
    const home = await family(gymId), device = (await factory('kioskDevices', gymId)).id;
    await factory('waiverTemplates', gymId, { name: 'Training waiver', version: 1 });
    const current = await factory('waiverTemplates', gymId, { name: 'Training waiver', version: 2 });
    await factory('waiverTemplates', gymId, { kind: 'agreement', name: 'Membership agreement' });
    const request = { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: null }] };
    expect(await service.checkin(gymId, device, request)).toEqual([{ status: 'see_front_desk' }]);
    await factory('waiverSignatures', gymId, { templateId: current.id, memberId: home.parent.id });
    expect(await service.checkin(gymId, device, request)).toMatchObject([{ status: 'checked_in' }]);
    await factory('waiverTemplates', gymId, { name: current.name, version: 3, retiredAt: clock.now() });
    expect(await service.checkin(gymId, device, { ...request, checkins: [{ memberId: home.child.id, sessionId: null }] })).toMatchObject([{ status: 'checked_in' }]);
    await database.forGym(gymId, (tx) => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, home.parent.id)));
    expect(await service.checkin(gymId, device, request)).toEqual([{ status: 'see_front_desk' }]);
  });
  it('keeps a session removed between selection and recording behind the neutral response', async () => {
    const home = await family();
    const session = await factory('classSessions', gymA, { startsAt: at(-5), endsAt: at(45) });
    let removed = false;
    const scope: typeof database.forGym = async (gymId, fn) => {
      const result = await database.forGym(gymId, fn);
      // Commit a concurrent schedule change after the real session query, before attendance reads it.
      if (!removed && Array.isArray(result) && result.some((row: unknown) => row && typeof row === 'object' && 'id' in row && row.id === session.id && 'endsAt' in row)) {
        removed = true;
        await database.forGym(gymId, (tx) => tx.delete(classSessions).where(eq(classSessions.id, session.id)));
      }
      return result;
    };
    const racing = createKioskCheckin({ scope, clock, pinSecret: async (gymId) => secrets.get(gymId)! });
    expect(await racing.checkin(gymA, deviceA, { name: home.name, pin: home.pin,
      checkins: [{ memberId: home.parent.id, sessionId: session.id }] })).toEqual([{ status: 'see_front_desk' }]);
    expect(removed).toBe(true); expect(await visits(gymA, home.parent.id)).toHaveLength(0);
  });
});

describe('kiosk check-in routes', () => {
  function server(principal: Principal, gymId = gymA, checkinService = service) {
    const app = new OpenAPIHono<RequestEnvironment>({ defaultHook: (result, ctx) => { if (!result.success) return respondError(ctx, result.error); } });
    app.use('*', async (ctx, next) => { ctx.set('context', { principal, gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, requestId: 'test', clock }); await next(); });
    app.onError(errorHandler);
    createServerRegistry({ routes: createKioskCheckinRoutes(checkinService) }).mount(app, authorize, new Set()); return app;
  }
  const post = (app: ReturnType<typeof server>, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('accepts only the gym\'s own kiosk devices for check-in, and staff for standing', async () => {
    const home = await family(), userId = (await factory('authUser', gymA)).id;
    const kiosk = server({ kind: 'kiosk', gymId: gymA, deviceId: deviceA });
    const lookup = await post(kiosk, '/api/kiosk/lookup', { name: home.name, pin: home.pin });
    expect(lookup.status).toBe(200); expect(lookup.headers.get('Cache-Control')).toBe('no-store');
    const checkin = await post(kiosk, '/api/kiosk/checkin', { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: null }] });
    expect((await checkin.json() as { data: unknown[] }).data).toMatchObject([{ status: 'checked_in' }]);
    for (const role of staffRoles) {
      const app = server({ kind: 'staff', gymId: gymA, userId, roles: [role] });
      expect((await post(app, '/api/kiosk/lookup', { name: home.name, pin: home.pin })).status).toBe(403);
      expect((await post(app, '/api/kiosk/checkin', { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id }] })).status).toBe(403);
      expect((await app.request('/api/kiosk/standing/' + home.parent.id)).status).toBe(200);
    }
    expect((await kiosk.request('/api/kiosk/standing/' + home.parent.id)).status).toBe(403);
    // Another gym's device and staff never reach gym A's members.
    expect((await server({ kind: 'staff', gymId: gymB, userId, roles: ['owner'] }, gymB).request('/api/kiosk/standing/' + home.parent.id)).status).toBe(404);
    const foreign = await post(server({ kind: 'kiosk', gymId: gymB, deviceId: deviceB }, gymB), '/api/kiosk/checkin', { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: null }] });
    expect((await foreign.json() as { data: unknown[] }).data).toEqual([{ status: 'see_front_desk' }]);
    for (const principal of [{ kind: 'anonymous' } as const, { kind: 'member', userId, scope: { gymId: gymA, householdId: home.id, role: 'payer' } } as const]) {
      expect([401, 403]).toContain((await post(server(principal), '/api/kiosk/lookup', { name: home.name, pin: home.pin })).status);
      expect([401, 403]).toContain((await post(server(principal), '/api/kiosk/checkin', { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id }] })).status);
      expect([401, 403]).toContain((await server(principal).request('/api/kiosk/standing/' + home.parent.id)).status);
    }
    expect((await post(server({ kind: 'kiosk', gymId: gymB, deviceId: deviceB }, gymB), '/api/kiosk/lookup', { name: home.name, pin: home.pin })).status).toBe(200);
    for (const path of ['/api/kiosk/lookup', '/api/kiosk/checkin'])
      expect((await post(server({ kind: 'kiosk', gymId: gymB, deviceId: deviceB }), path,
        { name: home.name, pin: home.pin, ...(path.endsWith('checkin') ? { checkins: [{ memberId: home.parent.id }] } : {}) })).status).toBe(403);
  });
  it('never exposes billing reasons, amounts, or provider errors through kiosk responses', async () => {
    const home = await family();
    for (const fails of [false, true]) {
      const privateStanding = createStandingChecks([{ id: 'billing', async check() {
        if (fails) throw new AppError('conflict', 'past due $123.45');
        return { status: 'front_desk', reasonCode: 'past due $123.45' };
      } }]);
      const privateService = createKioskCheckin({ scope: database.forGym, clock,
        pinSecret: async (gymId) => secrets.get(gymId)!, standing: privateStanding });
      const app = server({ kind: 'kiosk', gymId: gymA, deviceId: deviceA }, gymA, privateService);
      const response = await post(app, '/api/kiosk/checkin', { name: home.name, pin: home.pin, checkins: [{ memberId: home.parent.id, sessionId: null }] });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ data: [{ status: 'see_front_desk' }] });
      expect(JSON.stringify(body)).not.toMatch(/past.due|123|amount|currency|billing|reason/i);
    }
    expect(await visits(gymA, home.parent.id)).toHaveLength(0);
  });
});

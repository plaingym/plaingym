// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { attendances, auditEvents, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { kioskCheckinResponseSchema } from '@plaingym/shared/contracts';
import { staffRoles } from '@plaingym/shared';
import type { Principal } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createApp } from '../../core/app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { encryptSecret } from '../../core/secrets.js';
import { authorize } from '../staff/auth.permissions.js';
import { createGymKeyResolver } from '../settings/gym-keys.js';
import { PostgresMaintenance } from '../health/backups.database.js';
import { createCheckinCodeService, hashCheckinCode } from '../members/checkin-code.js';
import { configureCheckinCodes } from '../members/checkin-code.routes.js';
import { createQrCheckin } from './qr.js';
import { configureQrCheckin } from './qr.routes.js';
import { createKioskDeviceService } from './devices.js';
import { createKioskAuthMiddleware } from './devices.auth.js';
import { createStandingChecks } from './standing/standing.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-29T18:00:00Z');
const encryptionKey = randomBytes(32), gymA = uuidv7(), gymB = uuidv7();
const gymKey = createGymKeyResolver({ key: encryptionKey, scope: db.forGym });
const codes = createCheckinCodeService({ scope: db.forGym, clock, gymKey });
const devices = createKioskDeviceService({ scope: db.forGym, clock });
const qr = createQrCheckin({ scope: db.forGym, clock, codes });
let userId: string, deviceId: string, token: string;
const context = () => ({ gymId: gymA, actor: { kind: 'user' as const, userId } });
beforeAll(async () => {
  for (const gym of [gymA, gymB]) await factory('gyms', gym, { qrKey: encryptSecret(encryptionKey, 'qr_key', randomBytes(32).toString('base64url')) });
  userId = (await factory('authUser', gymA)).id;
  const registered = await devices.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'QR tablet' });
  deviceId = registered.device.id; token = registered.token;
  configureCheckinCodes({ scope: db.forGym, clock, gymKey });
  configureQrCheckin({ scope: db.forGym, clock, codes });
});
async function person(gymId = gymA) {
  const household = await factory('households', gymId);
  return factory('members', gymId, { householdId: household.id, firstName: 'Dana', lastName: 'PrivateSurname', status: 'active' });
}
const issue = (row: { id: string; revision: number }) => codes.regenerate(context(), row.id, { revision: row.revision });
const visits = (id: string) => db.forGym(gymA, (tx) => tx.select().from(attendances).where(eq(attendances.memberId, id)));
function app(principal?: Principal, gymId = gymA) {
  return createApp({ clock, authorize, contributions: areaContributions, skipSetup: true,
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: principal ? async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); }
      : createKioskAuthMiddleware({ service: devices }),
  });
}
const request = (code: string, sessionId: string | null | undefined = null) => ({ method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ code, sessionId }) });

describe('QR check-in and revocable member codes', () => {
  it('re-derives the same code on any device, storing only lowercase SHA-256 and auditing changes without secrets', async () => {
    const member = await person(), issued = await issue(member);
    expect(issued.code).toMatch(/^pgci1_[A-Za-z0-9_-]{43}$/);
    expect(await codes.read(gymA, member.id)).toEqual(issued);
    const [stored] = await db.forGym(gymA, (tx) => tx.select().from(members).where(eq(members.id, member.id)));
    expect(stored!.checkinCodeHash).toBe(hashCheckinCode(issued.code!));
    expect(stored!.checkinCodeHash).toMatch(/^[a-f0-9]{64}$/);
    const events = await db.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, member.id)));
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ action: 'member.checkin_code.regenerated', actorUserId: userId });
    expect(JSON.stringify(events)).not.toContain(issued.code!); expect(JSON.stringify(events)).not.toContain(stored!.checkinCodeHash!);
  });
  it('rejects regenerated/revoked codes including cached session choices, and never reactivates a revoked code on read', async () => {
    const member = await person(), first = await issue(member);
    expect(await qr.checkin(gymA, deviceId, { code: first.code })).toMatchObject({ status: 'select_session' });
    const second = await codes.regenerate(context(), member.id, { revision: first.revision });
    expect(second.code).not.toBe(first.code);
    expect(await qr.checkin(gymA, deviceId, { code: first.code, sessionId: null })).toEqual({ status: 'see_front_desk' });
    await expect(codes.regenerate(context(), member.id, { revision: first.revision })).rejects.toMatchObject({ name: 'RevisionConflictError' });
    await codes.revoke(context(), member.id, { revision: second.revision });
    expect(await codes.read(gymA, member.id)).toMatchObject({ code: null });
    expect(await codes.resolve(gymA, second.code!)).toBeNull();
    expect(await visits(member.id)).toHaveLength(0);
  });
  it('allows exactly one of two revision-checked resets', async () => {
    const member = await person();
    const results = await Promise.allSettled([issue(member), issue(member)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
  it('isolates gyms and households; a code only checks in its own member', async () => {
    const member = await person(), sibling = await person(), issued = await issue(member);
    expect(await codes.resolve(gymB, issued.code!)).toBeNull();
    const wrongGym = await app(undefined, gymB).request('/api/kiosk/checkin/qr', request(issued.code!));
    expect(wrongGym.status).toBe(404); // device token is gym-bound too
    const foreignDevice = (await factory('kioskDevices', gymB)).id;
    expect(await qr.checkin(gymB, foreignDevice, { code: issued.code, sessionId: null })).toEqual({ status: 'see_front_desk' });
    const foreignResponse = await app({ kind: 'kiosk', gymId: gymB, deviceId: foreignDevice }, gymB).request('/api/kiosk/checkin/qr', request(issued.code!));
    expect(foreignResponse.status).toBe(200); expect(await foreignResponse.json()).toEqual({ data: { status: 'see_front_desk' } });
    const response = await app().request('/api/kiosk/checkin/qr', request(issued.code!));
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(kioskCheckinResponseSchema.parse(await response.json())).toMatchObject({ data: { status: 'checked_in', member: { firstName: 'Dana', lastInitial: 'P' } } });
    expect(await visits(sibling.id)).toHaveLength(0);
    const tampered = request(issued.code!); tampered.body = JSON.stringify({ code: issued.code, memberId: sibling.id, sessionId: null });
    expect((await app().request('/api/kiosk/checkin/qr', tampered)).status).toBe(400);
    const [visit] = await visits(member.id);
    expect(visit).toMatchObject({ source: 'kiosk', kind: 'open_mat' });
    const [event] = await db.forGym(gymA, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.targetId, visit!.id)));
    expect(event).toMatchObject({ actorKind: 'device', actorDeviceId: deviceId });
  });
  it('auto-selects exactly one booked current session, prompts on ambiguity and ignores foreign/ineligible booking IDs', async () => {
    const member = await person(), issued = await issue(member);
    const at = (minutes: number) => new Date(clock.now().getTime() + minutes * 60_000);
    const first = await factory('classSessions', gymA, { startsAt: at(-5), endsAt: at(45) });
    const second = await factory('classSessions', gymA, { startsAt: at(10), endsAt: at(60) });
    let bookings = [first.id];
    const booked = createQrCheckin({ scope: db.forGym, clock, codes, bookedSessions: async (gym, id, ids) => {
      expect(gym).toBe(gymA); expect(id).toBe(member.id); expect(ids).toContain(first.id); return bookings;
    } });
    expect(await booked.checkin(gymA, deviceId, { code: issued.code })).toMatchObject({ status: 'checked_in' });
    expect(await booked.checkin(gymA, deviceId, { code: issued.code })).toMatchObject({ status: 'already_checked_in' });
    expect((await visits(member.id))[0]!.sessionId).toBe(first.id);
    bookings = [first.id, second.id];
    expect(await booked.checkin(gymA, deviceId, { code: issued.code })).toMatchObject({ status: 'select_session', sessions: [{ id: first.id }, { id: second.id }] });
    bookings = [uuidv7()];
    expect(await booked.checkin(gymA, deviceId, { code: issued.code })).toMatchObject({ status: 'select_session' });
    expect(await booked.checkin(gymA, deviceId, { code: issued.code, sessionId: uuidv7() })).toMatchObject({ status: 'select_session' });
    expect(await visits(member.id)).toHaveLength(1);
  });
  it('keeps inactive/erased members, waiver and billing failures neutral and private', async () => {
    const member = await person(), issued = await issue(member);
    const blocked = createQrCheckin({ scope: db.forGym, clock, codes, standing: createStandingChecks([
      { id: 'billing', check: async () => ({ status: 'front_desk', reasonCode: 'private_balance_500' }) },
    ]) });
    expect(await blocked.checkin(gymA, deviceId, { code: issued.code, sessionId: null })).toEqual({ status: 'see_front_desk' });
    await db.forGym(gymA, (tx) => tx.update(members).set({ status: 'frozen' }).where(eq(members.id, member.id)));
    expect(await qr.checkin(gymA, deviceId, { code: issued.code, sessionId: null })).toEqual({ status: 'see_front_desk' });
    await db.forGym(gymA, (tx) => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, member.id)));
    expect(await codes.resolve(gymA, issued.code!)).toBeNull();
    expect(await visits(member.id)).toHaveLength(0);
  });
  it('survives the actual restore secret re-encryption path with a new APP_ENCRYPTION_KEY', async () => {
    const member = await person(), issued = await issue(member), newKey = randomBytes(32);
    await new PostgresMaintenance(db.maintenanceUrl).rekey(encryptionKey, newKey, clock);
    const restored = createCheckinCodeService({ scope: db.forGym, clock, gymKey: createGymKeyResolver({ key: newKey, scope: db.forGym }) });
    expect(await restored.read(gymA, member.id)).toEqual(issued);
    expect(await restored.resolve(gymA, issued.code!)).toBe(member.id);
    expect(await createQrCheckin({ scope: db.forGym, clock, codes: restored }).checkin(gymA, deviceId, { code: issued.code, sessionId: null }))
      .toMatchObject({ status: 'checked_in' });
    // Put keys back for the other independent cases in this file.
    await new PostgresMaintenance(db.maintenanceUrl).rekey(newKey, encryptionKey, clock);
  });
  it.each(staffRoles)('checks every staff endpoint permission for %s and denies QR to staff', async (role) => {
    const member = await person(), principal = { kind: 'staff' as const, userId, gymId: gymA, roles: [role] };
    const allowed = role === 'owner' || role === 'admin' || role === 'front_desk';
    for (const method of ['GET', 'POST', 'DELETE']) {
      const revision = (await codes.read(gymA, member.id)).revision;
      const response = await app(principal).request('/api/members/' + member.id + '/checkin-code', { method,
        headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ revision }) }) });
      expect(response.status).toBe(allowed ? 200 : 403);
    }
    expect((await app(principal).request('/api/kiosk/checkin/qr', request('invalid'))).status).toBe(403);
  });
  it('rejects cross-gym staff resources, member sessions, anonymous callers and device tokens on staff endpoints', async () => {
    const member = await person(), principal = { kind: 'staff' as const, userId, gymId: gymB, roles: ['owner' as const] };
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await app(principal, gymB).request('/api/members/' + member.id + '/checkin-code', { method,
        headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ revision: 1 }) }) });
      expect(response.status).toBe(404);
    }
    const memberPrincipal: Principal = { kind: 'member', userId, scope: { gymId: gymA, householdId: member.householdId, memberId: member.id, role: 'member' } };
    for (const principal of [{ kind: 'anonymous' as const }, memberPrincipal]) {
      for (const method of ['GET', 'POST', 'DELETE']) expect((await app(principal).request('/api/members/' + member.id + '/checkin-code', { method,
        headers: { 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify({ revision: 1 }) }) })).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
      expect((await app(principal).request('/api/kiosk/checkin/qr', request('invalid'))).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
    }
    expect((await app().request('/api/members/' + member.id + '/checkin-code', { headers: { Authorization: 'Bearer ' + token } })).status).toBe(404);
  });
  it('fails malformed, unknown and revoked devices without disclosing a member', async () => {
    expect(await qr.checkin(gymA, deviceId, { code: 'invalid' })).toEqual({ status: 'see_front_desk' });
    const fresh = await devices.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Revoked' });
    await devices.revoke({ gymId: gymA, actor: { kind: 'system' } }, fresh.device.id);
    const req = request('pgci1_' + 'a'.repeat(43)); req.headers.Authorization = 'Bearer ' + fresh.token;
    expect((await app().request('/api/kiosk/checkin/qr', req)).status).toBe(404);
  });
});

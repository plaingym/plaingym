// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError } from '@plaingym/shared';
import { kioskContracts, portalContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import { createKioskDeviceService } from './devices.js';
import { createKioskDeviceRoutes } from './devices.routes.js';
import { createKioskAuthMiddleware, markKioskPinChecked, type KioskAuthOptions } from './devices.auth.js';
import { createPinLimitAudit, pinLimitReachedAction } from './pin-limit.js';
import { createApp } from '../../core/app.js';
import { route } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { setLogSink } from '../../core/log.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const service = createKioskDeviceService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
let token: string, deviceId: string, secondToken: string;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  const first = await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Check-in device' });
  token = first.token; deviceId = first.device.id;
  secondToken = (await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Second device' })).token;
});
let verificationGate: Promise<void> | undefined;
let verificationStarted: (() => void) | undefined;
/**
 * Stands in for the check-in service: 'Verified' matches, 'Nobody' compares no PIN, 'Broken' fails before any check,
 * 'Silent' reports nothing, and any other name is a wrong PIN.
 */
async function checkPin(request: Request, name: string) {
  if (name === 'Nobody') return markKioskPinChecked(request, 'skipped');
  if (name === 'Broken') throw new AppError('unavailable', 'Kiosk PIN check-in is not configured');
  if (name === 'Silent') return;
  if (name !== 'Verified') return markKioskPinChecked(request, 'compared');
  verificationStarted?.(); await verificationGate;
  markKioskPinChecked(request, 'verified');
}
const checkinRoutes = [
  route({ ...kioskContracts.lookup, request: { body: { required: true, content: { 'application/json': { schema: kioskContracts.lookup.body } } } },
    responses: { 200: { description: 'Lookup fixture', content: { 'application/json': { schema: kioskContracts.lookup.response } } } } },
  async (c) => {
    await checkPin(c.req.raw, c.req.valid('json').name);
    return c.json({ data: { status: 'see_front_desk' as const } }, 200);
  }),
  route({ ...kioskContracts.checkinNamePin, request: { body: { required: true, content: { 'application/json': { schema: kioskContracts.checkinNamePin.body } } } },
    responses: { 200: { description: 'Check-in fixture', content: { 'application/json': { schema: kioskContracts.checkinNamePin.response } } } } },
  async (c) => {
    await checkPin(c.req.raw, c.req.valid('json').name);
    return c.json({ data: [{ status: 'see_front_desk' as const }] }, 200);
  }),
  route({ ...kioskContracts.checkinQr, request: { body: { required: true, content: { 'application/json': { schema: kioskContracts.checkinQr.body } } } },
    responses: { 200: { description: 'QR fixture', content: { 'application/json': { schema: kioskContracts.checkinQr.response } } } } },
  (c) => c.json({ data: { status: 'see_front_desk' as const } }, 200)),
  route({ ...portalContracts.context, responses: { 200: { description: 'Portal fixture', content: { 'application/json': { schema: portalContracts.context.response } } } } },
  (c) => c.json({ data: { role: 'payer' as const, householdId: uuidv7(), memberId: null } }, 200)),
];
function server(options: KioskAuthOptions = {}, principal: Principal = { kind: 'anonymous' }) {
  const session = vi.fn<MiddlewareHandler<RequestEnvironment>>(async (c, next) => {
    c.set('context', { ...c.get('context'), principal }); await next();
  });
  const middleware = createKioskAuthMiddleware({ service, session, pinLimitReached: createPinLimitAudit({ scope: database.forGym }), ...options });
  const app = createApp({
    clock, authorize,
    resolveGym: async (c, next) => {
      const gymId = new URL(c.req.url).hostname === 'b.example' ? gymB : gymA;
      c.set('context', { ...c.get('context'), gym: { gymId, timezone: 'UTC', enabledModules: new Set() } }); await next();
    },
    session: middleware, contributions: { routes: [...createKioskDeviceRoutes(service), ...checkinRoutes] },
  });
  return { app, session };
}
const pinBody = { name: 'Alex', pin: '1234' };
const bodies = [
  [kioskContracts.lookup.path, pinBody],
  [kioskContracts.checkinNamePin.path, { ...pinBody, checkins: [{ memberId: uuidv7(), sessionId: null }] }],
  [kioskContracts.checkinQr.path, { code: 'qr-fixture' }],
] as const;
function request(app: ReturnType<typeof server>['app'], path = kioskContracts.lookup.path as string,
  bearer = token, body: unknown = pinBody, headers: Record<string, string> = {}, host = 'a.example') {
  return app.request('https://' + host + path, { method: 'POST',
    headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
describe('kiosk authentication middleware', () => {
  it('authenticates exactly the three check-in contracts and bypasses session replacement', async () => {
    const { app, session } = server();
    for (const [path, body] of bodies) {
      const result = await request(app, path, token, body);
      expect(result.status).toBe(200);
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(JSON.stringify(await result.json())).not.toContain(token);
    }
    expect(session).not.toHaveBeenCalled();
    expect(await service.authenticate(gymA, token)).toEqual({ kind: 'kiosk', gymId: gymA, deviceId });
  });
  it('does not grant any management, portal, auth or unlisted endpoint access, even with a staff cookie', async () => {
    const { app, session } = server({}, { kind: 'staff', gymId: gymA, userId: uuidv7(), roles: ['owner'] });
    for (const path of ['/api/kiosk/devices', '/api/kiosk/devices/' + deviceId + '/revoke',
      '/api/portal/context', '/api/settings', '/api/auth/get-session', '/api/kiosk/lookup/extra', '/api/kiosk/checkin/qr/']) {
      expect((await request(app, path, token, {}, { cookie: 'session=staff' })).status).toBe(404);
      expect((await app.request('https://a.example' + path, { headers: { authorization: 'Bearer ' + token } })).status).toBe(404);
    }
    expect(session).not.toHaveBeenCalled();
  });
  it('keeps normal staff session management working and denies non-kiosk PIN requests', async () => {
    const userId = (await factory('authUser', gymA)).id;
    const { app, session } = server({}, { kind: 'staff', gymId: gymA, userId, roles: ['owner'] });
    expect((await app.request('https://a.example/api/kiosk/devices')).status).toBe(200);
    const result = await app.request('https://a.example/api/kiosk/devices', { method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://a.example', cookie: 'session=staff' }, body: JSON.stringify({ name: 'Staff-created' }) });
    expect(result.status).toBe(200); expect(session).toHaveBeenCalledTimes(2);
    expect((await app.request('https://a.example/api/kiosk/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pinBody) })).status).toBe(403);
    const anonymous = server().app;
    expect((await anonymous.request('https://a.example/api/kiosk/lookup', { method: 'POST' })).status).toBe(401);
  });
  it('rejects cross-gym tokens, missing, revoked, malformed and unknown tokens before any handler', async () => {
    const { app } = server();
    for (const [path, body] of bodies) {
      expect((await app.request('https://b.example' + path, { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(404);
    }
    for (const value of ['Basic secret', 'Bearer bad', 'Bearer ' + 'X'.repeat(43), 'Bearer ' + token + ' suffix', ''])
      expect((await request(app, kioskContracts.lookup.path, token, {}, { authorization: value })).status).toBe(404);
    const revocable = await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Revoked now' });
    expect((await request(app, kioskContracts.lookup.path, revocable.token)).status).toBe(200);
    await service.revoke({ gymId: gymA, actor: { kind: 'system' } }, revocable.device.id);
    for (const [path, body] of bodies) expect((await request(app, path, revocable.token, body)).status).toBe(404);
  });
  it('shares the device PIN budget between lookup and check-in across changing client addresses', async () => {
    let peer = '192.0.2.1';
    const { app } = server({ pinLimit: 2, peerAddress: () => peer });
    expect((await request(app)).status).toBe(200);
    peer = '192.0.2.2';
    expect((await request(app, bodies[1][0], token, bodies[1][1])).status).toBe(200);
    peer = '192.0.2.3';
    const limited = await request(app);
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
    // QR does not spend a PIN attempt.
    expect((await request(app, bodies[2][0], token, bodies[2][1])).status).toBe(200);
    clock.advance(60_000);
    expect((await request(app)).status).toBe(200);
  });
  it('releases verified attempts without resetting earlier failed PINs, even for a neutral standing result', async () => {
    const { app } = server({ pinLimit: 2 });
    expect((await request(app)).status).toBe(200);
    for (let i = 0; i < 12; i++) expect((await request(app, bodies[0][0], token, { ...pinBody, name: 'Verified' })).status).toBe(200);
    expect((await request(app)).status).toBe(200);
    expect((await request(app)).status).toBe(429);
  });
  it('releases attempts that compare no PIN, answering the kiosk exactly as before', async () => {
    const pinLimitReached = vi.fn(async () => {});
    const { app } = server({ pinLimit: 2, pinLimitReached });
    const checkin = (name: string) => ({ name, pin: '1234', checkins: [{ memberId: uuidv7(), sessionId: null }] });
    for (let i = 0; i < 5; i++) {
      // No household or too many matched the name: the same neutral answer, and no PIN was compared.
      const lookup = await request(app, kioskContracts.lookup.path, token, { ...pinBody, name: 'Nobody' });
      expect(lookup.status).toBe(200); expect(await lookup.json()).toEqual({ data: { status: 'see_front_desk' } });
      const family = await request(app, kioskContracts.checkinNamePin.path, token, checkin('Nobody'));
      expect(family.status).toBe(200); expect(await family.json()).toEqual({ data: [{ status: 'see_front_desk' }] });
      // An invalid body and a server error before the comparison answer as before too.
      expect((await request(app, kioskContracts.lookup.path, token, { name: 'Alex', pin: '12' })).status).toBe(400);
      expect((await request(app, kioskContracts.checkinNamePin.path, token, {})).status).toBe(400);
      expect((await request(app, kioskContracts.lookup.path, token, { ...pinBody, name: 'Broken' })).status).toBe(503);
      expect((await request(app, kioskContracts.checkinNamePin.path, token, checkin('Broken'))).status).toBe(503);
    }
    expect(pinLimitReached).not.toHaveBeenCalled();
    // The whole budget is still there for wrong PINs, on the device and on its address.
    expect((await request(app)).status).toBe(200);
    expect((await request(app, kioskContracts.checkinNamePin.path, token, checkin('Alex'))).status).toBe(200);
    expect(pinLimitReached).toHaveBeenCalledTimes(1);
    expect((await request(app, kioskContracts.lookup.path, token, { ...pinBody, name: 'Nobody' })).status).toBe(429);
  });
  it('counts an answered attempt the check-in service never reported, so a missing report fails closed', async () => {
    const pinLimitReached = vi.fn(async () => {});
    const { app } = server({ pinLimit: 2, pinLimitReached });
    for (let i = 0; i < 2; i++) expect((await request(app, kioskContracts.lookup.path, token, { ...pinBody, name: 'Silent' })).status).toBe(200);
    expect(pinLimitReached).toHaveBeenCalledTimes(1);
    expect((await request(app)).status).toBe(429);
  });
  it('reserves in-flight attempts so concurrent requests cannot bypass the PIN limit', async () => {
    const { app } = server({ pinLimit: 1 });
    let release!: () => void;
    verificationGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const first = request(app, bodies[0][0], token, { ...pinBody, name: 'Verified' });
    try {
      await started;
      expect((await request(app)).status).toBe(429);
    } finally { release(); verificationStarted = undefined; verificationGate = undefined; }
    expect((await first).status).toBe(200);
    expect((await request(app, bodies[0][0], token, { ...pinBody, name: 'Verified' })).status).toBe(200);
  });
  it('shares the client address budget across devices and ignores untrusted forwarding headers', async () => {
    const { app } = server({ pinLimit: 2, peerAddress: () => '192.0.2.1' });
    expect((await request(app)).status).toBe(200);
    expect((await request(app, kioskContracts.lookup.path, secondToken)).status).toBe(200);
    expect((await request(app, kioskContracts.lookup.path, secondToken, pinBody, { 'x-forwarded-for': '192.0.2.99' })).status).toBe(429);
  });
  it('takes the nearest trusted proxy address, never the attacker-supplied first address', async () => {
    const { app } = server({ pinLimit: 1, peerAddress: () => '127.0.0.1', trustedProxy: (ip) => ip === '127.0.0.1' });
    expect((await request(app, bodies[0][0], token, pinBody, { 'x-forwarded-for': '192.0.2.99, 192.0.2.1' })).status).toBe(200);
    expect((await request(app, bodies[0][0], secondToken, pinBody, { 'x-forwarded-for': '192.0.2.55, 192.0.2.1' })).status).toBe(429);
    expect((await request(app, bodies[0][0], secondToken, pinBody, { 'x-forwarded-for': '192.0.2.55, 192.0.2.2' })).status).toBe(200);
  });
  it('evicts the oldest buckets at capacity instead of refusing new devices, keeping real refusals', async () => {
    let peer = '192.0.2.1';
    const { app } = server({ pinLimit: 1, maxBuckets: 2, peerAddress: () => peer });
    expect((await request(app)).status).toBe(200);
    peer = '192.0.2.2';
    const refused = await request(app);
    expect(refused.status).toBe(429); expect(refused.headers.get('retry-after')).toBe('60');
    // The second device and a new address make room by evicting the oldest buckets rather than refusing.
    expect((await request(app, bodies[0][0], secondToken)).status).toBe(200);
  });
  it('shares the address budget across a /64 and counts IPv4-mapped addresses as IPv4', async () => {
    const third = (await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Third device' })).token;
    let peer = '2001:db8:a:b::1';
    const { app } = server({ pinLimit: 1, peerAddress: () => peer });
    expect((await request(app)).status).toBe(200);
    peer = '2001:db8:a:b:ffff::2';
    expect((await request(app, bodies[0][0], secondToken)).status).toBe(429);
    peer = '2001:db8:a:c::1';
    expect((await request(app, bodies[0][0], secondToken)).status).toBe(200);
    peer = '::ffff:192.0.2.9';
    expect((await request(app, bodies[0][0], third)).status).toBe(200);
    peer = '192.0.2.9';
    const other = (await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Fourth device' })).token;
    expect((await request(app, bodies[0][0], other)).status).toBe(429);
  });
  it('audits a device using up its PIN budget once per window, with the device as the actor', async () => {
    const device = await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Guessed device' });
    const audits = () => database.forGym(gymA, (tx) => tx.select().from(auditEvents)
      .where(and(eq(auditEvents.action, pinLimitReachedAction), eq(auditEvents.targetId, device.device.id))));
    let peer = '192.0.2.40';
    const { app } = server({ pinLimit: 2, peerAddress: () => peer });
    const guess = (body: unknown = pinBody) => request(app, bodies[0][0], device.token, body);
    // Verified attempts don't spend the budget, so they never count as using it up.
    for (let i = 0; i < 3; i++) expect((await guess({ ...pinBody, name: 'Verified' })).status).toBe(200);
    expect((await guess()).status).toBe(200);
    expect(await audits()).toEqual([]);
    expect((await guess()).status).toBe(200);
    for (let i = 0; i < 3; i++) { peer = '192.0.2.' + (41 + i); expect((await guess()).status).toBe(429); }
    expect(await audits()).toEqual([expect.objectContaining({ gymId: gymA, actorKind: 'device', actorDeviceId: device.device.id,
      actorUserId: null, targetType: 'kiosk_device',
      after: { limit: 2, budgets: ['device', 'address'], windowEndsAt: new Date(clock.now().getTime() + 60_000).toISOString() } })]);
    clock.advance(60_000);
    for (let i = 0; i < 2; i++) expect((await guess()).status).toBe(200);
    expect(await audits()).toHaveLength(2);
    expect(await database.forGym(gymB, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, pinLimitReachedAction)))).toEqual([]);
  });
  it('audits kiosks sharing an address that use up its budget together, apart from other gyms', async () => {
    const register = async (gymId: string, name: string) => service.register({ gymId, actor: { kind: 'system' } }, { name });
    const first = await register(gymA, 'Front tablet'), second = await register(gymA, 'Mat tablet'), foreign = await register(gymB, 'Next door');
    const audits = (gymId: string) => database.forGym(gymId, (tx) => tx.select().from(auditEvents).where(eq(auditEvents.action, pinLimitReachedAction)));
    const before = await audits(gymA);
    let peer = '198.51.100.7';
    const { app } = server({ pinLimit: 2, peerAddress: () => peer });
    expect((await request(app, kioskContracts.lookup.path, first.token)).status).toBe(200);
    // Another gym's kiosk behind the same address has its own budget there.
    for (let i = 0; i < 2; i++)
      expect((await request(app, kioskContracts.lookup.path, foreign.token, pinBody, {}, 'b.example')).status).toBe(200);
    expect((await request(app, kioskContracts.lookup.path, second.token)).status).toBe(200);
    // Neither device used up its own budget, but together they used up their address's, which locks both out.
    for (const device of [first, second]) expect((await request(app, kioskContracts.lookup.path, device.token)).status).toBe(429);
    const added = (await audits(gymA)).filter((row) => !before.some((old) => old.id === row.id));
    expect(added).toEqual([expect.objectContaining({ actorKind: 'device', actorDeviceId: second.device.id, targetId: second.device.id,
      after: { limit: 2, budgets: ['address'], windowEndsAt: new Date(clock.now().getTime() + 60_000).toISOString() } })]);
    expect(await audits(gymB)).toEqual([expect.objectContaining({ actorDeviceId: foreign.device.id,
      after: expect.objectContaining({ budgets: ['device', 'address'] }) })]);
    // The first device still has budget of its own at another address.
    peer = '198.51.100.8';
    expect((await request(app, kioskContracts.lookup.path, first.token)).status).toBe(200);
  });
  it('reports a used-up budget from settled failures, not from in-flight attempts that later verify', async () => {
    const device = await service.register({ gymId: gymA, actor: { kind: 'system' } }, { name: 'Busy device' });
    const pinLimitReached = vi.fn(async () => {});
    const { app } = server({ pinLimit: 2, pinLimitReached });
    let release!: () => void;
    verificationGate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const verified = request(app, bodies[0][0], device.token, { ...pinBody, name: 'Verified' });
    try {
      await started;
      expect((await request(app, bodies[0][0], device.token)).status).toBe(200);
      expect(pinLimitReached).not.toHaveBeenCalled();
    } finally { release(); verificationStarted = undefined; verificationGate = undefined; }
    expect((await verified).status).toBe(200);
    expect((await request(app, bodies[0][0], device.token)).status).toBe(200);
    expect(pinLimitReached).toHaveBeenCalledTimes(1);
    expect((await request(app, bodies[0][0], device.token)).status).toBe(429);
  });
  it('answers the kiosk the same when recording the used-up budget fails', async () => {
    const lines: string[] = [], previous = setLogSink((line) => { lines.push(line); });
    try {
      const pinLimitReached = vi.fn(async () => { throw new Error('database unavailable'); });
      const { app } = server({ pinLimit: 1, pinLimitReached });
      expect((await request(app)).status).toBe(200);
      expect((await request(app)).status).toBe(429);
      expect(pinLimitReached).toHaveBeenCalledTimes(1);
      expect(lines.map((line) => JSON.parse(line) as { event: string })).toEqual([expect.objectContaining({ event: 'kiosk.pin_limit.audit_failed' })]);
    } finally { setLogSink(previous); }
  });
  it('keeps real kiosk bearer requests compatible with the CSRF guard', async () => {
    const { app } = server({ pinLimit: 1 });
    const headers = { cookie: 'stale=staff', origin: 'https://unrelated.example', 'sec-fetch-site': 'cross-site' };
    expect((await request(app, bodies[0][0], token, {}, headers)).status).toBe(400);
    expect((await request(app, bodies[0][0], token, pinBody, headers)).status).toBe(200);
    expect((await request(app, bodies[0][0], token, pinBody, headers)).status).toBe(429);
    expect((await request(app, bodies[2][0], token, bodies[2][1], headers)).status).toBe(200);
  });
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid rate settings: %s', (value) => {
    for (const key of ['pinLimit', 'windowMs', 'maxBuckets'])
      expect(() => createKioskAuthMiddleware({ [key]: value })).toThrow();
  });
});

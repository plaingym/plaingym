// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { kioskContracts, portalContracts } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import { createKioskDeviceService } from './devices.js';
import { createKioskDeviceRoutes } from './devices.routes.js';
import { createKioskAuthMiddleware, type KioskAuthOptions } from './devices.auth.js';
import { createApp } from '../../core/app.js';
import { route } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';

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
const checkinRoutes = [
  route({ ...kioskContracts.lookup, request: { body: { required: true, content: { 'application/json': { schema: kioskContracts.lookup.body } } } },
    responses: { 200: { description: 'Lookup fixture', content: { 'application/json': { schema: kioskContracts.lookup.response } } } } },
  (c) => c.json({ data: { status: 'see_front_desk' as const } }, 200)),
  route({ ...kioskContracts.checkinNamePin, request: { body: { required: true, content: { 'application/json': { schema: kioskContracts.checkinNamePin.body } } } },
    responses: { 200: { description: 'Check-in fixture', content: { 'application/json': { schema: kioskContracts.checkinNamePin.response } } } } },
  (c) => c.json({ data: [{ status: 'see_front_desk' as const }] }, 200)),
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
  const middleware = createKioskAuthMiddleware({ service, session, ...options });
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
  bearer = token, body: unknown = pinBody, headers: Record<string, string> = {}) {
  return app.request('https://a.example' + path, { method: 'POST',
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
  it('fails closed at bucket capacity and reclaims expired buckets', async () => {
    const { app } = server({ pinLimit: 10, maxBuckets: 2, peerAddress: () => '192.0.2.1' });
    expect((await request(app)).status).toBe(200);
    expect((await request(app, bodies[0][0], secondToken)).status).toBe(429);
    clock.advance(60_000);
    expect((await request(app, bodies[0][0], secondToken)).status).toBe(200);
  });
  it('counts invalid PIN payloads and keeps real kiosk bearer requests compatible with the CSRF guard', async () => {
    const { app } = server({ pinLimit: 1 });
    const headers = { cookie: 'stale=staff', origin: 'https://unrelated.example', 'sec-fetch-site': 'cross-site' };
    expect((await request(app, bodies[0][0], token, {}, headers)).status).toBe(400);
    expect((await request(app, bodies[0][0], token, pinBody, headers)).status).toBe(429);
    expect((await request(app, bodies[2][0], token, bodies[2][1], headers)).status).toBe(200);
  });
  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid rate settings: %s', (value) => {
    for (const key of ['pinLimit', 'windowMs', 'maxBuckets'])
      expect(() => createKioskAuthMiddleware({ [key]: value })).toThrow();
  });
});

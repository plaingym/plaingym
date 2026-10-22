// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, kioskDevices, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { staffRoles, type StaffRole } from '@plaingym/shared';
import { kioskDeviceListResponseSchema, kioskDeviceResponseSchema, registerKioskDeviceResponseSchema } from '@plaingym/shared/contracts';
import { createKioskDeviceService } from './devices.js';
import { createKioskDeviceRoutes } from './devices.routes.js';
import { createServerRegistry } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
import { authorize } from '../staff/auth.permissions.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const service = createKioskDeviceService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
let userId: string;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  userId = (await factory('authUser', gymA)).id;
});
const mutation = (gymId = gymA) => ({ gymId, actor: { kind: 'user' as const, userId } });
const staff = (role: StaffRole = 'owner', gymId = gymA): Principal => ({ kind: 'staff', gymId, userId, roles: [role] });
function server(principal: Principal = staff(), gymId = gymA, bypassAuthorization = false) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'devices-test' });
    await next();
  });
  app.onError(errorHandler);
  createServerRegistry({ routes: createKioskDeviceRoutes(service) }).mount(app,
    bypassAuthorization ? () => async (_c, next) => { await next(); } : authorize, new Set());
  return app;
}
const post = (app: ReturnType<typeof server>, path: string, body?: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const deviceRows = (gymId = gymA) => database.forGym(gymId, (tx) => tx.select().from(kioskDevices));
const audits = (gymId = gymA) => database.forGym(gymId, (tx) => tx.select().from(auditEvents));

describe('kiosk devices', () => {
  it('registers a 256-bit token once and never stores plaintext in rows or audits', async () => {
    const app = server(), response = await post(app, '/api/kiosk/devices', { name: '  Front desk  ' });
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const { device, token } = registerKioskDeviceResponseSchema.parse(await response.json()).data;
    expect(device.name).toBe('Front desk'); expect(device.createdAt).toBe(clock.now().toISOString());
    expect(device.revokedAt).toBeNull(); expect(device.lastSeenAt).toBeNull();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const row = (await deviceRows()).find((item) => item.id === device.id)!;
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await deviceRows())).not.toContain(token);
    const events = await audits();
    expect(JSON.stringify(events)).not.toContain(token); expect(JSON.stringify(events)).not.toContain(row.tokenHash);
    expect(events.find((event) => event.targetId === device.id)).toMatchObject({
      actorKind: 'user', actorUserId: userId, action: 'kiosk.device.registered', occurredAt: clock.now(),
    });
    const list = kioskDeviceListResponseSchema.parse(await (await app.request('/api/kiosk/devices')).json());
    expect(list.data.find((item) => item.id === device.id)).toEqual(device);
    expect(JSON.stringify(list)).not.toMatch(/token/);
  });
  it('paginates deterministically, counts only the current gym, and validates pagination', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    for (const name of ['One', 'Two', 'Three']) await service.register(mutation(gymId), { name });
    await service.register(mutation(gymB), { name: 'Other gym' });
    const app = server(staff('owner', gymId), gymId);
    const first = kioskDeviceListResponseSchema.parse(await (await app.request('/api/kiosk/devices?limit=2&offset=0')).json());
    const second = kioskDeviceListResponseSchema.parse(await (await app.request('/api/kiosk/devices?limit=2&offset=2')).json());
    expect(first.pagination).toEqual({ total: 3, limit: 2, offset: 0 });
    expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map((item) => item.id)).size).toBe(3);
    expect((await app.request('/api/kiosk/devices?limit=101')).status).toBe(400);
    expect((await app.request('/api/kiosk/devices?offset=-1')).status).toBe(400);
  });
  it.each(staffRoles)('enforces management permissions before validation for %s', async (role) => {
    const app = server(staff(role)), allowed = role === 'owner' || role === 'admin';
    const device = await service.register(mutation(), { name: role });
    expect((await app.request('/api/kiosk/devices')).status).toBe(allowed ? 200 : 403);
    expect((await post(app, '/api/kiosk/devices', {})).status).toBe(allowed ? 400 : 403);
    expect((await post(app, '/api/kiosk/devices', { name: role })).status).toBe(allowed ? 200 : 403);
    expect((await post(app, '/api/kiosk/devices/not-an-id/revoke')).status).toBe(allowed ? 400 : 403);
    const result = await post(app, '/api/kiosk/devices/' + device.device.id + '/revoke');
    expect(result.status).toBe(allowed ? 200 : 403);
    if (allowed) expect(kioskDeviceResponseSchema.safeParse(await result.json()).success).toBe(true);
  });
  it('denies anonymous, member and kiosk principals on every device route', async () => {
    const device = await service.register(mutation(), { name: 'No access' });
    const principals: Principal[] = [{ kind: 'anonymous' },
      { kind: 'member', userId, scope: { role: 'payer', gymId: gymA, householdId: uuidv7() } },
      { kind: 'kiosk', gymId: gymA, deviceId: device.device.id }];
    for (const principal of principals) {
      const app = server(principal), status = principal.kind === 'anonymous' ? 401 : 403;
      expect((await app.request('/api/kiosk/devices')).status).toBe(status);
      expect((await post(app, '/api/kiosk/devices', {})).status).toBe(status);
      expect((await post(app, '/api/kiosk/devices/' + device.device.id + '/revoke')).status).toBe(status);
    }
  });
  it('isolates lists and revocation by gym, even with authorization bypassed', async () => {
    const foreign = await service.register(mutation(gymB), { name: 'Private B device' });
    const app = server();
    const list = await (await app.request('/api/kiosk/devices')).text();
    expect(list).not.toContain(foreign.device.id); expect(list).not.toContain('Private B device');
    expect((await post(app, '/api/kiosk/devices/' + foreign.device.id + '/revoke')).status).toBe(404);
    expect((await service.list(gymB)).data.find((item) => item.id === foreign.device.id)?.revokedAt).toBeNull();
    // Each handler independently rejects a principal from a different resolved gym.
    const mismatch = server(staff(), gymB, true);
    expect((await mismatch.request('/api/kiosk/devices')).status).toBe(404);
    expect((await post(mismatch, '/api/kiosk/devices', { name: 'Forged' })).status).toBe(404);
    expect((await post(mismatch, '/api/kiosk/devices/' + foreign.device.id + '/revoke')).status).toBe(404);
    await expect(service.authenticate(gymA, foreign.token)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('uses the injected clock, revokes immediately, and keeps repeated revocation idempotent', async () => {
    const registered = await service.register(mutation(), { name: 'Revocable' });
    clock.advance(1000);
    expect(await service.authenticate(gymA, registered.token)).toEqual({ kind: 'kiosk', gymId: gymA, deviceId: registered.device.id });
    const [seen] = await database.forGym(gymA, (tx) => tx.select().from(kioskDevices).where(eq(kioskDevices.id, registered.device.id)));
    expect(seen!.lastSeenAt).toEqual(clock.now());
    const firstSeen = clock.now();
    clock.advance(59_999);
    await service.authenticate(gymA, registered.token);
    expect((await database.forGym(gymA, (tx) => tx.select().from(kioskDevices).where(eq(kioskDevices.id, registered.device.id))))[0]!.lastSeenAt).toEqual(firstSeen);
    clock.advance(1);
    await Promise.all([service.authenticate(gymA, registered.token), service.authenticate(gymA, registered.token)]);
    expect((await database.forGym(gymA, (tx) => tx.select().from(kioskDevices).where(eq(kioskDevices.id, registered.device.id))))[0]!.lastSeenAt).toEqual(clock.now());
    clock.advance(1000);
    const revoked = await service.revoke(mutation(), registered.device.id);
    expect(revoked.revokedAt).toBe(clock.now().toISOString());
    await expect(service.authenticate(gymA, registered.token)).rejects.toMatchObject({ code: 'not_found' });
    clock.advance(1000);
    expect(await service.revoke(mutation(), registered.device.id)).toEqual(revoked);
    const events = (await audits()).filter((event) => event.targetId === registered.device.id);
    expect(events.map((event) => event.action).sort()).toEqual(['kiosk.device.registered', 'kiosk.device.revoked']);
  });
  it('rolls back device mutations when their audit cannot commit', async () => {
    const actor = { kind: 'user' as const, userId: uuidv7() }, before = await deviceRows();
    await expect(service.register({ gymId: gymA, actor }, { name: 'Must roll back' })).rejects.toThrow();
    expect(await deviceRows()).toEqual(before);
    const registered = await service.register(mutation(), { name: 'Still active' });
    await expect(service.revoke({ gymId: gymA, actor }, registered.device.id)).rejects.toThrow();
    await expect(service.authenticate(gymA, registered.token)).resolves.toMatchObject({ deviceId: registered.device.id });
  });
  it('rejects malformed names, extra fields, unknown tokens and missing devices', async () => {
    const app = server();
    for (const body of [{ name: '' }, { name: '   ' }, { name: 'Device', gymId: gymB }, { name: 'Device', token: 'chosen' }])
      expect((await post(app, '/api/kiosk/devices', body)).status).toBe(400);
    for (const token of ['', 'bad', 'A'.repeat(43), 'A'.repeat(44), '../token'])
      await expect(service.authenticate(gymA, token)).rejects.toMatchObject({ code: 'not_found' });
    expect((await post(app, '/api/kiosk/devices/' + uuidv7() + '/revoke')).status).toBe(404);
    const a = await service.register(mutation(), { name: 'Same name' });
    const b = await service.register(mutation(), { name: 'Same name' });
    expect(a.token).not.toBe(b.token); expect(a.device.id).not.toBe(b.device.id);
  });
});

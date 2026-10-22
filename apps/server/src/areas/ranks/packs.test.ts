// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { auditEvents, installedPacks, rankSystems, ranks, programs, classTags, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type ContentPack, type StaffRole } from '@plaingym/shared';
import { ranksContracts } from '@plaingym/shared/contracts';
import { createContentPackService } from './packs.js';
import { createContentPackRoutes } from './packs.routes.js';
import { createServerRegistry } from '../../core/registry.js';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
const service = createContentPackService({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();
let userId: string;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  userId = (await factory('authUser', gymA)).id;
});
function pack(id: string): ContentPack {
  return { version: 1, id, name: id,
    rankSystems: [{ id: 'system', name: `${id} system`, ranks: [
      { id: 'beginner', name: 'Beginner', color: '#ffffff', subRanks: [{ id: 'one', name: 'One' }] },
      { id: 'advanced', name: 'Advanced', color: '#000000', subRanks: [] },
    ] }],
    programs: [{ id: 'ranked', name: `${id} ranked`, rankSystemId: 'system' }, { id: 'unranked', name: `${id} unranked` }],
    classTags: [{ id: 'basics', name: `${id} basics` }, { id: 'practice', name: `${id} practice` }],
  };
}
const mutation = (gymId = gymA) => ({ gymId, actor: { kind: 'user', userId } } as const);
async function snapshot(gymId = gymA) {
  return database.forGym(gymId, async (tx) => ({
    installed: await tx.select().from(installedPacks), systems: await tx.select().from(rankSystems),
    ranks: await tx.select().from(ranks), programs: await tx.select().from(programs), tags: await tx.select().from(classTags),
    audits: await tx.select().from(auditEvents),
  }));
}
function server(role: StaffRole = 'owner', gymId = gymA, principal?: Principal, bypassAuthorization = false) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => {
    c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: principal ?? { kind: 'staff', gymId, userId, roles: [role] }, clock, requestId: 'packs-test' });
    await next();
  });
  app.onError((error, c) => c.json(errorResponse(error, 'packs-test'), error instanceof AppError ? error.status : 500));
  createServerRegistry({ routes: createContentPackRoutes(service) }).mount(app,
    bypassAuthorization ? () => async (_c, next) => { await next(); } : authorize, new Set());
  return app;
}
const apply = (app: ReturnType<typeof server>, value: unknown) => app.request('/api/content-packs/apply', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
});

describe('content pack application with Postgres RLS', () => {
  it('installs ranks, sub-ranks, programs and tags atomically and replays without changing IDs or revisions', async () => {
    const definition = pack('idempotent');
    const first = await service.apply(mutation(), definition), before = await snapshot();
    expect(first.programs[0]!.rankSystemId).toBe(first.rankSystems[0]!.id);
    expect(first.programs[1]!.rankSystemId).toBeNull();
    expect(first.installedPack.createdAt).toBe(clock.now().toISOString());
    expect(before.ranks.find((rank) => rank.name === 'Beginner')).toMatchObject({ position: 0, color: '#ffffff', subRanks: [{ id: 'one', name: 'One' }] });
    expect(before.ranks.find((rank) => rank.name === 'Advanced')).toMatchObject({ position: 1, color: '#000000' });
    expect(await service.apply(mutation(), definition)).toEqual(first);
    const after = await snapshot();
    expect({ ...after, audits: [] }).toEqual({ ...before, audits: [] });
    const audit = after.audits.at(-1)!;
    expect(audit).toMatchObject({ actorKind: 'user', actorUserId: userId, targetId: first.installedPack.id, occurredAt: clock.now(), after: { pack: definition } });
    for (const row of [...after.installed, ...after.systems, ...after.ranks, ...after.programs, ...after.tags]) {
      expect(row.gymId).toBe(gymA); expect(row.id).toMatch(/^[0-9a-f-]{14}7[0-9a-f]{3}-[89ab]/);
    }
  });
  it('updates colors without changing identities, preserves criteria, and clears omitted colors', async () => {
    const definition = pack('colors');
    const installed = await service.apply(mutation(), definition);
    const rows = await database.forGym(gymA, (tx) => tx.select().from(ranks).where(eq(ranks.rankSystemId, installed.rankSystems[0]!.id)));
    const beginner = rows.find((row) => row.name === 'Beginner')!;
    await database.forGym(gymA, (tx) => tx.update(ranks).set({ criteria: [{ providerId: 'classes', config: { count: 5 } }] }).where(eq(ranks.id, beginner.id)));
    definition.rankSystems[0]!.ranks[0]!.color = '#123456';
    delete definition.rankSystems[0]!.ranks[1]!.color;
    await service.apply(mutation(), definition);
    const updated = await database.forGym(gymA, (tx) => tx.select().from(ranks).where(eq(ranks.rankSystemId, installed.rankSystems[0]!.id)));
    expect(updated.find((row) => row.id === beginner.id)).toMatchObject({ color: '#123456', revision: 2, criteria: [{ providerId: 'classes', config: { count: 5 } }] });
    expect(updated.find((row) => row.name === 'Advanced')).toMatchObject({ color: null, revision: 2 });
    await service.apply(mutation(), definition);
    expect(await database.forGym(gymA, (tx) => tx.select().from(ranks).where(eq(ranks.rankSystemId, installed.rankSystems[0]!.id)))).toEqual(updated);
  });
  it('serializes concurrent first installation and does not duplicate any entities', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const results = await Promise.all(Array.from({ length: 5 }, () => service.apply(mutation(gymId), pack('concurrent'))));
    for (const result of results) expect(result).toEqual(results[0]);
    const rows = await snapshot(gymId);
    expect(rows.installed).toHaveLength(1); expect(rows.systems).toHaveLength(1); expect(rows.ranks).toHaveLength(2);
    expect(rows.programs).toHaveLength(2); expect(rows.tags).toHaveLength(2); expect(rows.audits).toHaveLength(5);
  });
  it('updates by stable pack IDs, swaps rank positions, and preserves staff criteria and inactive programs', async () => {
    const definition = pack('editable');
    const first = await service.apply(mutation(), definition);
    const original = await database.forGym(gymA, async (tx) => {
      const rows = await tx.select().from(ranks).where(eq(ranks.rankSystemId, first.rankSystems[0]!.id));
      await tx.update(ranks).set({ criteria: [{ providerId: 'classes', config: { count: 10 } }], revision: 2 }).where(eq(ranks.id, rows[0]!.id));
      await tx.update(programs).set({ active: false, revision: 2 }).where(eq(programs.id, first.programs[0]!.id));
      return rows;
    });
    definition.rankSystems[0]!.name = 'Renamed system';
    definition.rankSystems[0]!.ranks.reverse();
    definition.rankSystems[0]!.ranks[1]!.name = 'Renamed beginner';
    definition.rankSystems[0]!.ranks[1]!.subRanks.push({ id: 'two', name: 'Two' });
    definition.programs[0]!.name = 'Renamed program'; definition.classTags[0]!.name = 'Renamed tag';
    const second = await service.apply(mutation(), definition);
    expect(second.installedPack.id).toBe(first.installedPack.id);
    expect(second.rankSystems[0]).toMatchObject({ id: first.rankSystems[0]!.id, name: 'Renamed system', revision: 2 });
    expect(second.programs[0]).toMatchObject({ id: first.programs[0]!.id, name: 'Renamed program', active: false, revision: 3 });
    const updated = (await snapshot()).ranks.filter((row) => row.rankSystemId === first.rankSystems[0]!.id);
    expect(updated.map((row) => row.id).sort()).toEqual(original.map((row) => row.id).sort());
    expect(updated.find((row) => row.name === 'Renamed beginner')).toMatchObject({ position: 1, subRanks: definition.rankSystems[0]!.ranks[1]!.subRanks });
    expect(updated.find((row) => row.id === original[0]!.id)!.criteria).toEqual([{ providerId: 'classes', config: { count: 10 } }]);
    expect(await service.apply(mutation(), definition)).toEqual(second);
  });
  it('reuses shared class tags without changing their identity or revision', async () => {
    const definition = pack('shared-tags');
    const tag = await factory('classTags', gymA, { name: definition.classTags[0]!.name });
    await service.apply(mutation(), definition); await service.apply(mutation(), definition);
    const rows = (await snapshot()).tags.filter((row) => row.name === tag.name);
    expect(rows).toEqual([tag]);
  });
  it('rolls back the entire installation on a name collision without leaking SQL', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const definition = pack('conflicting');
    await factory('programs', gymId, { name: definition.programs[0]!.name });
    const before = await snapshot(gymId);
    const response = await apply(server('owner', gymId), { pack: definition });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'conflict' } });
    expect(await snapshot(gymId)).toEqual(before);
  });
  it('rolls back entity writes if the audit cannot be written', async () => {
    const gymId = uuidv7(); await factory('gyms', gymId);
    const before = await snapshot(gymId);
    await expect(service.apply({ gymId, actor: { kind: 'user', userId: uuidv7() } }, pack('bad-audit'))).rejects.toMatchObject({ code: 'conflict' });
    expect(await snapshot(gymId)).toEqual(before);
  });
  it('keeps installations and every related entity isolated across gyms', async () => {
    const beforeB = await snapshot(gymB), definition = pack('isolation');
    const a = await service.apply(mutation(), definition);
    expect(await snapshot(gymB)).toEqual(beforeB);
    expect((await service.list(gymB)).data).toEqual([]);
    const b = await service.apply({ gymId: gymB, actor: { kind: 'system' } }, definition);
    expect(b.installedPack.id).not.toBe(a.installedPack.id);
    expect(b.rankSystems[0]!.id).not.toBe(a.rankSystems[0]!.id);
    expect((await service.list(gymA)).data.some((row) => row.id === b.installedPack.id)).toBe(false);
    expect((await snapshot(gymB)).audits[0]).toMatchObject({ actorKind: 'system', actorUserId: null });
  });
  it.each([2, 0, '1'])('rejects unsupported format version %j before accessing the database', async (version) => {
    const before = await snapshot();
    await expect(service.apply(mutation(), { ...pack('invalid-version'), version })).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it('rejects duplicate display names which cannot fit the database uniqueness constraints', async () => {
    const definition = pack('duplicate-names'); definition.programs[1]!.name = definition.programs[0]!.name;
    await expect(service.apply(mutation(), definition)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('lists installed packs with validated pagination and total count', async () => {
    const result = await service.list(gymA, { limit: 1, offset: 1 });
    expect(result.data).toHaveLength(1); expect(result.pagination).toMatchObject({ limit: 1, offset: 1 });
    expect(result.pagination.total).toBeGreaterThan(1);
    const response = await server().request('/api/content-packs?limit=1&offset=999');
    expect(response.status).toBe(200);
    const json = ranksContracts.listPacks.response.parse(await response.json());
    expect(json.data).toEqual([]); expect(json.pagination.total).toBe(result.pagination.total);
    expect((await server().request('/api/content-packs?limit=0')).status).toBe(400);
  });
  it.each(staffRoles)('enforces permissions on both pack endpoints for %s before validation', async (role) => {
    const allowed = role === 'owner' || role === 'admin', app = server(role);
    expect((await app.request('/api/content-packs')).status).toBe(allowed ? 200 : 403);
    expect((await apply(app, {})).status).toBe(allowed ? 400 : 403);
    const result = await apply(app, { pack: pack(`permission-${role.replaceAll('_', '-')}`) });
    expect(result.status).toBe(allowed ? 200 : 403);
    if (allowed) expect(ranksContracts.applyPack.response.safeParse(await result.json()).success).toBe(true);
  });
  it('rejects anonymous and kiosk principals on both staff endpoints', async () => {
    for (const principal of [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: gymA, deviceId: uuidv7() }] as const) {
      const app = server('owner', gymA, principal), status = principal.kind === 'anonymous' ? 401 : 403;
      expect((await app.request('/api/content-packs')).status).toBe(status);
      expect((await apply(app, { pack: pack('untrusted') })).status).toBe(status);
    }
  });
  it('returns 404 for a cross-gym principal even with a permissive injected authorizer', async () => {
    const before = await snapshot(gymB);
    const app = server('owner', gymB, { kind: 'staff', gymId: gymA, userId, roles: ['owner'] }, true);
    expect((await app.request('/api/content-packs')).status).toBe(404);
    expect((await apply(app, { pack: pack('cross-gym') })).status).toBe(404);
    expect(await snapshot(gymB)).toEqual(before);
  });
  it('does not accept a client-supplied target gym or malformed packs', async () => {
    const app = server();
    for (const value of [
      { pack: pack('injected'), gymId: gymB },
      { pack: { ...pack('injected'), gymId: gymB } },
      { pack: { ...pack('invalid'), version: 42 } },
      { pack: { ...pack('invalid'), programs: [{ id: 'a', name: 'A', rankSystemId: 'missing' }] } },
    ]) expect((await apply(app, value)).status).toBe(400);
  });
});

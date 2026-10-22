// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { gyms, gymDomains, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTenantResolver, defaultHostname, listGyms, normalizeHostname, singleGymId, tenancyMode } from './tenancy.js';
import type { RequestEnvironment } from './context.js';
const database = useTestDatabase(), factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7();
beforeAll(async () => {
  await factory('gyms', gymA, { timezone: 'America/Vancouver', websiteEnabled: true });
  await factory('gyms', gymB, { timezone: 'Asia/Tokyo' });
  await factory('gymDomains', gymA, { hostname: 'a.example.test' });
  await factory('gymDomains', gymB, { hostname: 'b.example.test' });
});
function app(mode: 'single' | 'multi') {
  const app = new Hono<RequestEnvironment>();
  app.use('*', createTenantResolver({ mode, system: database.forSystem }));
  app.get('/', (c) => c.json({ ...c.get('context').gym, enabledModules: [...c.get('context').gym.enabledModules] }));
  return app;
}
describe('tenant resolution', () => {
  it('resolves normalized hosts concurrently and ignores forwarded host headers', async () => {
    const server = app('multi');
    const [a, b] = await Promise.all([
      server.request('https://unused/', { headers: { host: 'A.Example.Test.:443', 'x-forwarded-host': 'b.example.test' } }),
      server.request('https://b.example.test/'),
    ]);
    expect(await a.json()).toEqual({ gymId: gymA, timezone: 'America/Vancouver', enabledModules: ['website'] });
    expect(await b.json()).toEqual({ gymId: gymB, timezone: 'Asia/Tokyo', enabledModules: [] });
    expect((await server.request('https://unknown.example.test/')).status).toBe(404);
    expect((await server.request('https://a.example.test/', { headers: { host: 'a.example.test@b.example.test' } })).status).toBe(404);
  });
  it('applies module toggles and suspension on the next request', async () => {
    await database.forGym(gymA, (tx) => tx.update(gyms).set({ websiteEnabled: false }).where(eq(gyms.id, gymA)));
    expect((await (await app('multi').request('https://a.example.test/')).json()).enabledModules).toEqual([]);
    await database.forSystem((tx) => tx.update(gyms).set({ status: 'suspended' }).where(eq(gyms.id, gymB)));
    expect((await app('multi').request('https://b.example.test/')).status).toBe(404);
  });
  it('fails closed on multiple gyms in single mode and resolves the sole gym independently of its domain', async () => {
    const server = app('single');
    expect((await server.request('https://a.example.test/')).status).toBe(404);
    await database.forSystem(async (tx) => { await tx.delete(gymDomains).where(eq(gymDomains.gymId, gymB)); await tx.delete(gyms).where(eq(gyms.id, gymB)); });
    expect((await (await server.request('https://other.example.test/')).json()).gymId).toBe(gymA);
    await database.forSystem(async (tx) => { await tx.delete(gymDomains); await tx.delete(gyms); });
    expect((await server.request('https://other.example.test/')).status).toBe(404);
  });
  it.each(['', 'a/b', 'a@b', 'a b', '-bad.test', 'a.test:99999', 'a.test:foo', 'a..test', 'a.test?x'])('rejects invalid host %s', (host) => {
    expect(normalizeHostname(host)).toBeNull();
  });
  it('normalizes IDN hosts and validates modes', () => {
    expect(normalizeHostname('BÜCHER.example:443')).toBe('xn--bcher-kva.example');
    expect(tenancyMode('single')).toBe('single'); expect(() => tenancyMode('typo')).toThrow('TENANCY');
  });
});
describe('runtime tenancy helpers', () => {
  it('lists active gyms with their timezones for scheduled jobs', async () => {
    // Earlier tests remove the shared fixtures, so this one creates its own gyms.
    const active = uuidv7(), suspended = uuidv7();
    await factory('gyms', active, { timezone: 'Europe/Paris' }); await factory('gyms', suspended, { status: 'suspended' });
    const listed = await listGyms(database.forSystem);
    expect(listed).toContainEqual({ gymId: active, timezone: 'Europe/Paris' });
    expect(listed.some((gym) => gym.gymId === suspended)).toBe(false);
  });
  it('finds a gym\'s default hostname and refuses an ambiguous single gym', async () => {
    const gymC = uuidv7(); await factory('gyms', gymC);
    await factory('gymDomains', gymC, { hostname: 'custom.example.test', kind: 'custom' });
    await factory('gymDomains', gymC, { hostname: 'c.example.test', kind: 'default' });
    expect(await defaultHostname(gymC, database.forSystem)).toBe('c.example.test');
    expect(await defaultHostname(uuidv7(), database.forSystem)).toBeNull();
    await expect(singleGymId(database.forSystem)).rejects.toThrow('exactly one gym');
  });
});

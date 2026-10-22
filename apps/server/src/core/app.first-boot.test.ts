// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from '@hono/zod-openapi';
import { AppError } from '@plaingym/shared';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { ranksContracts, setupContracts, type EndpointContract } from '@plaingym/shared/contracts';
import { createApp } from './app.js';
import { route } from './registry.js';
import { areaContributions } from './registry-areas.js';
import { createTenantResolver } from './tenancy.js';

const database = useTestDatabase();
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'plaingym-first-boot-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<html>Setup shell</html>');
  await writeFile(join(directory, 'assets', 'app.js'), 'console.log("setup");');
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

const ok = z.object({ ok: z.literal(true) });
function fixture(contract: EndpointContract, allowed = () => true) {
  return route({ method: contract.method, path: contract.path, permission: contract.permission,
    responses: { 200: { description: 'First-boot fixture', content: { 'application/json': { schema: ok } } } },
  }, (context) => {
    if (!allowed()) throw new AppError('not_found', 'Setup is complete.');
    return context.json({ ok: true as const }, 200);
  });
}
const resolveGym = () => { throw new AppError('not_found', 'Gym not found.'); };
const session = () => { throw new Error('First boot must not load a gym session'); };
const authorize = () => () => { throw new Error('First boot must not need staff authorization'); };

describe('first-boot application routing with no gym', () => {
  it('serves the shell, assets and shipped catalog without resolving a gym or loading a session', async () => {
    const app = createApp({ resolveGym: createTenantResolver({ mode: 'single', system: database.forSystem }),
      session, authorize, publicDirectory: directory, contributions: areaContributions });
    for (const path of ['/setup', '/setup/restore', '/admin', '/login']) {
      const response = await app.request(path, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Setup shell');
    }
    expect((await app.request('/assets/app.js')).status).toBe(200);
    const response = await app.request('/api/content-packs/catalog');
    expect(response.status).toBe(200);
    const { data } = ranksContracts.catalog.response.parse(await response.json());
    expect(data.map((pack) => pack.id)).toEqual(['bjj', 'functional-fitness', 'judo', 'karate', 'muay-thai']);
    for (const pack of data) {
      expect(Object.keys(pack).sort()).toEqual(['id', 'name', 'summary', 'version']);
      expect(pack.summary.length).toBeGreaterThan(pack.name.length);
    }
    for (const path of ['/api/settings', '/api/auth/bootstrap', '/api/content-packs', '/api/setup/missing', '/webhooks/stripe']) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it('mounts only the public first-boot contracts early and preserves each handler guard', async () => {
    let initialized = false;
    const app = createApp({ resolveGym, session, authorize, contributions: {
      routes: Object.values(setupContracts).map((contract) => fixture(contract, () => !initialized)),
    } });
    for (const contract of Object.values(setupContracts)) {
      const path = contract.path.replace('{jobId}', '019a08bf-1234-7000-8000-000000000001');
      const request = () => app.request(path, { method: contract.method.toUpperCase() });
      expect((await request()).status).toBe(contract.gate === 'uninitialized_install' ? 200 : 404);
    }
    initialized = true;
    expect((await app.request('/api/setup')).status).toBe(404);
    expect((await app.request('/api/setup/restore', { method: 'POST' })).status).toBe(404);
  });

  it('runs the restore gate before tenant access while the coordinator and status reader remain reachable', async () => {
    const calls: string[] = [];
    const app = createApp({ resolveGym: () => { calls.push('tenant'); return resolveGym(); }, session, authorize,
      restoreGate: () => { calls.push('gate'); throw new AppError('unavailable', 'Restore in progress'); },
      contributions: { routes: Object.values(setupContracts).map((contract) => fixture(contract)) }, publicDirectory: directory,
    });
    for (const path of ['/setup', '/api/setup', '/api/settings']) expect((await app.request(path)).status).toBe(503);
    expect((await app.request('/api/setup/owner', { method: 'POST' })).status).toBe(503);
    expect(calls).toEqual(['gate', 'gate', 'gate', 'gate']);
    expect((await app.request('/api/setup/restore', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/setup/restore/019a08bf-1234-7000-8000-000000000001')).status).toBe(200);
    expect((await app.request('/healthz')).status).toBe(200);
    expect(calls).not.toContain('tenant');
  });

  it('protects first-boot writes with install-origin CSRF and an install-scoped rate limit', async () => {
    const app = createApp({ resolveGym, session, authorize, installOrigin: 'https://gym.example',
      origin: () => { throw new Error('No gym exists from which to derive an origin'); },
      rateLimit: { limit: 1 }, contributions: { routes: [fixture(setupContracts.start)] },
    });
    const request = (origin: string) => app.request('/api/setup/start', { method: 'POST', headers: { cookie: 'session=old', origin } });
    expect((await request('https://evil.example')).status).toBe(403);
    expect((await request('https://gym.example')).status).toBe(200);
    expect((await request('https://gym.example')).status).toBe(429);
  });
});

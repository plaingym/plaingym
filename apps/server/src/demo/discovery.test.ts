// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gymDomains, gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { demoEntryResponse } from '@plaingym/shared/contracts';
import { startRuntime, type Runtime } from '../core/runtime.js';

const database = useTestDatabase(), factory = createFactories(database);
const ordinaryOrigin = 'https://gym.example.test', demoOrigin = 'https://demo.example.test';
const expiresAt = '2099-10-24T12:00:00.000Z';
let runtime: Runtime;
const env = () => ({ DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
  AUTH_SECRET: 'discovery-secret-with-at-least-32-characters', NODE_ENV: 'production', PUBLIC_ORIGIN: ordinaryOrigin });
const get = (origin: string, path = '/api/demo') => runtime.app.request(origin + path, { headers: { host: new URL(origin).host } });

describe('fresh runtime discovery', () => {
  beforeAll(async () => { runtime = await startRuntime(env()); });
  afterAll(async () => { await runtime?.stop(); });

  it('returns disabled discovery on the configured host before setup creates a gym or domain', async () => {
    expect(await database.forSystem((tx) => tx.select().from(gyms))).toHaveLength(0);
    expect(await database.forSystem((tx) => tx.select().from(gymDomains))).toHaveLength(0);
    const response = await get(ordinaryOrigin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(demoEntryResponse.parse(await response.json())).toEqual({ data: { mode: 'disabled' } });
    expect((await get('https://unknown.example.test')).status).toBe(404);
  });
});

describe('ordinary runtime discovery', () => {
  beforeAll(async () => {
    const gymId = uuidv7();
    await factory('gyms', gymId, { settings: { setupComplete: true } });
    // A restored single-gym database can still contain the previous server's hostname.
    await factory('gymDomains', gymId, { hostname: 'previous.example.test' });
    runtime = await startRuntime(env());
  });
  afterAll(async () => { await runtime?.stop(); });

  it('returns disabled discovery on the configured host even with a restored domain from another server', async () => {
    const response = await get(ordinaryOrigin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(demoEntryResponse.parse(await response.json())).toEqual({ data: { mode: 'disabled' } });
    for (const path of ['/api/demo/sandboxes', '/api/demo/login']) {
      const disabled = await runtime.app.request(ordinaryOrigin + path, { method: 'POST',
        headers: { host: new URL(ordinaryOrigin).host, 'content-type': 'application/json' }, body: '{}' });
      expect(disabled.status).toBe(404);
    }
    expect((await get(ordinaryOrigin, '/api/demo/status')).status).toBe(404);
  });

  it('rejects unknown hosts even though single-gym tenant resolution accepts other hostnames', async () => {
    expect((await get('https://unknown.example.test')).status).toBe(404);
    expect((await get('https://previous.example.test')).status).toBe(404);
  });
});

describe.each([undefined, ordinaryOrigin])('ordinary multi-tenant runtime discovery (PUBLIC_ORIGIN=%s)', (publicOrigin) => {
  beforeAll(async () => {
    for (const name of ['gym-a', 'gym-b', 'suspended-gym']) {
      const gymId = uuidv7();
      await factory('gyms', gymId, { status: name === 'suspended-gym' ? 'suspended' : 'active', settings: { setupComplete: true } });
      await factory('gymDomains', gymId, { hostname: `${name}.${publicOrigin ? 'configured' : 'unconfigured'}.example.test` });
    }
    const environment: NodeJS.ProcessEnv = env();
    delete environment.PUBLIC_ORIGIN;
    runtime = await startRuntime({ ...environment, ...(publicOrigin ? { PUBLIC_ORIGIN: publicOrigin } : {}),
      TENANCY: 'multi', DEMO_MODE: 'false', AUTH_PASSWORD_LOGIN: 'off', SMTP_HOST: '127.0.0.1',
      UPLOADS_S3_BUCKET: 'test-uploads', UPLOADS_S3_ENDPOINT: 'http://127.0.0.1:1',
      UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' });
  });
  afterAll(async () => { await runtime?.stop(); });

  it.each(['gym-a', 'gym-b'])('returns disabled discovery for registered host %s', async (name) => {
    const origin = `https://${name}.${publicOrigin ? 'configured' : 'unconfigured'}.example.test`;
    expect((await get(origin, '/api/auth/bootstrap')).status).toBe(200);
    const response = await get(origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(demoEntryResponse.parse(await response.json())).toEqual({ data: { mode: 'disabled' } });
    for (const path of ['/api/demo/sandboxes', '/api/demo/login']) {
      const disabled = await runtime.app.request(origin + path, { method: 'POST',
        headers: { host: new URL(origin).host, 'content-type': 'application/json' }, body: '{}' });
      expect(disabled.status).toBe(404);
    }
    expect((await get(origin, '/api/demo/status')).status).toBe(404);
  });

  it('rejects unknown and suspended gym hosts', async () => {
    expect((await get('https://unknown.example.test')).status).toBe(404);
    expect((await get(`https://suspended-gym.${publicOrigin ? 'configured' : 'unconfigured'}.example.test`)).status).toBe(404);
  });
});

describe('demo runtime discovery', () => {
  beforeAll(async () => {
    runtime = await startRuntime({ ...env(), PUBLIC_ORIGIN: demoOrigin, TENANCY: 'multi', DEMO_MODE: 'true',
      DEMO_DOMAIN: new URL(demoOrigin).hostname, UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: 'http://127.0.0.1:1',
      UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test' });
  });
  afterAll(async () => { await runtime?.stop(); });

  it('serves entry without a tenant or session', async () => {
    const response = await get(demoOrigin);
    expect(response.status).toBe(200);
    expect(demoEntryResponse.parse(await response.json())).toEqual({ data: { mode: 'entry' } });
  });

  it.each([
    { name: 'ready', ready: true, expiresAt, status: 'active', expected: 200 },
    { name: 'expired', ready: true, expiresAt: '2000-01-01T00:00:00.000Z', status: 'active', expected: 404 },
    { name: 'unready', ready: false, expiresAt, status: 'active', expected: 404 },
    { name: 'invalid', ready: true, expiresAt: 'invalid', status: 'active', expected: 404 },
    { name: 'suspended', ready: true, expiresAt, status: 'suspended', expected: 404 },
  ] as const)('checks $name sandboxes through the composed resolver and service', async (scenario) => {
    const gymId = uuidv7(), hostname = `${scenario.name}.demo.example.test`;
    await factory('gyms', gymId, { status: scenario.status,
      settings: { demo: { sandbox: true, ready: scenario.ready, expiresAt: scenario.expiresAt } } });
    await factory('gymDomains', gymId, { hostname });
    const response = await get('https://' + hostname);
    expect(response.status).toBe(scenario.expected);
    if (scenario.expected === 200)
      expect(demoEntryResponse.parse(await response.json())).toEqual({ data: { mode: 'sandbox', expiresAt } });
  });

  it('rejects ordinary gyms and unknown hosts rather than advertising a sandbox', async () => {
    expect((await get('https://previous.example.test')).status).toBe(404);
    expect((await get('https://unknown.example.test')).status).toBe(404);
  });
});

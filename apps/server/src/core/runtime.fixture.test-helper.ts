// SPDX-License-Identifier: AGPL-3.0-only
import { jsonInit } from '../../test/request.js';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, vi } from 'vitest';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { demoCreationResponse } from '@plaingym/shared/contracts';
import { startRuntime, type Runtime } from './runtime.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import type { JobHandler, SystemJobHandler } from '../infra/jobs/index.js';
import { s3Server } from '../infra/storage/s3-server.test-helper.js';

export const origin = 'https://demo.example.test';
export const demoStripeEnv = { DEMO_STRIPE_TEST_KEY: 'rk_test_runtime', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_runtime' };
export type Sandbox = { gymId: string; origin: string; kioskToken: string };

/** The demo runtime's settings: a multi-gym install in demo mode with S3 uploads, as the hosted demo runs. */
export const demoEnv = (databaseUrl: string, storageEndpoint: string, stagingDir: string) => ({
  DATABASE_URL: databaseUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'runtime-secret-with-at-least-32-characters',
  TENANCY: 'multi', DEMO_MODE: 'true', DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
  DEMO_POOL_SIZE: '0',
  UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: storageEndpoint,
  UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
  // Invalid SMTP would fail immediately if demo startup constructed a resolver.
  SMTP_HOST: 'never-connect.invalid', SMTP_SECURITY: 'invalid',
  BACKUP_STAGING_DIR: stagingDir,
});

/**
 * Call once at module scope in a runtime test file. Starts the production runtime in demo mode over the file's own
 * database and loopback S3 bucket, keeping its job handlers and workers so tests drive them without polling races.
 * With `sandbox: true` the file also creates one sandbox gym, which takes seconds, so each file that needs one makes
 * its own and tests only touch what they create.
 */
export function useDemoRuntime(options: { sandbox?: boolean } = {}) {
  const database = useTestDatabase(), factory = createFactories(database);
  const handlers = new Map<string, JobHandler>(), systemHandlers = new Map<string, SystemJobHandler>(), workers: PostgresJobs[] = [];
  const batchJobs = new Set<string>();
  let runtime: Runtime, directory: string, storage: Awaited<ReturnType<typeof s3Server>>, sandbox: Sandbox;
  const env = () => demoEnv(database.appUrl, storage.endpoint, join(directory, 'staging'));
  const post = (path: string, body: unknown, base = origin, extra: Record<string, string> = {}) => {
    const init = jsonInit(body);
    return runtime.app.request(base + path, { method: 'POST', ...init,
      headers: { ...init.headers, host: new URL(base).host, origin: base, ...extra } });
  };
  const cookieOf = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  beforeAll(async () => {
    // Keep production registrations and database jobs; drive their handlers explicitly without polling races.
    const handle = PostgresJobs.prototype.handle;
    vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler, options) {
      handlers.set(name, handler); handle.call(this, name, handler, options);
      if (options?.lane === 'batch') batchJobs.add(name);
    });
    const handleSystem = PostgresJobs.prototype.handleSystem;
    vi.spyOn(PostgresJobs.prototype, 'handleSystem').mockImplementation(function (this: PostgresJobs, name, handler) {
      systemHandlers.set(name, handler); handleSystem.call(this, name, handler);
    });
    vi.spyOn(PostgresJobs.prototype, 'start').mockImplementation(function (this: PostgresJobs) { workers.push(this); return { async stop() {} }; });
    directory = await mkdtemp(join(tmpdir(), 'runtime-demo-'));
    storage = await s3Server();
    runtime = await startRuntime(env());
    if (options.sandbox) sandbox = await createSandbox();
  }, 90_000);
  afterAll(async () => { await runtime?.stop(); await storage?.close(); if (directory) await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });
  async function createSandbox(): Promise<Sandbox> {
    const response = await post('/api/demo/sandboxes', {});
    expect(response.status, await response.clone().text()).toBe(201);
    let data = demoCreationResponse.parse(await response.json()).data;
    const deadline = Date.now() + 90_000;
    while ('pending' in data) {
      if (Date.now() >= deadline) throw new Error('Sandbox preparation timed out');
      if (!await workers.at(-1)!.runNext()) await new Promise(resolve => setTimeout(resolve, 2000));
      const progress = await runtime.app.request(origin + '/api/demo/creations/' + data.ticket, { headers: { host: new URL(origin).host } });
      expect(progress.status, await progress.clone().text()).toBe(200);
      data = demoCreationResponse.parse(await progress.json()).data;
    }
    return data;
  }
  return {
    database, factory, handlers, systemHandlers, workers, batchJobs, env, post, cookieOf, createSandbox,
    get runtime() { return runtime; },
    get directory() { return directory; },
    get sandbox() { return sandbox; },
    /** The job queue of the current runtime: the last one it started. */
    get queue() { return workers.at(-1)!; },
    /** The headers a browser sends to a sandbox's own host, with its session cookie when it has one. */
    headers: (at: Sandbox, cookie?: string) => ({ host: new URL(at.origin).host, ...(cookie ? { cookie } : {}) }),
    /** Signs in through the demo's one-click login and returns the session cookie. */
    async login(role: 'owner' | 'student', at: Sandbox = sandbox) {
      const response = await post('/api/demo/login', { role }, at.origin);
      expect(response.status).toBe(200);
      return cookieOf(response);
    },
    /** Delivers a signed `payment_intent.succeeded` for the sandbox's gym to the Stripe webhook inbox. */
    deliverStripeEvent(id: string, at: Sandbox = sandbox) {
      const body = JSON.stringify({ id, object: 'event', type: 'payment_intent.succeeded', livemode: false,
        data: { object: { id: 'pi_runtime', object: 'payment_intent', metadata: { gym_id: at.gymId } } } });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `t=${timestamp},v1=${createHmac('sha256', demoStripeEnv.DEMO_STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')}`;
      // A browser cookie on the request must not trip the origin check that guards cookie-authenticated writes.
      return runtime.app.request(at.origin + '/webhooks/stripe', { method: 'POST', body,
        headers: { host: new URL(at.origin).host, 'stripe-signature': signature, 'content-type': 'application/json', cookie: 'unrelated=1' } });
    },
    async restart(overrides: NodeJS.ProcessEnv = {}) {
      await runtime.stop();
      runtime = await startRuntime({ ...env(), ...overrides });
    },
  };
}

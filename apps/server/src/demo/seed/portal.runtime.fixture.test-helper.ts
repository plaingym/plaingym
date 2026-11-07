// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { clock } from '../../core/clock.js';
import { startRuntime, type Runtime } from '../../core/runtime.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import { FakePayments, type CreateCharge } from '../../infra/payments/index.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import * as seedPayments from './billing-payments.js';
import type { TestDatabase } from './seeded-database.test-helper.js';

export const install = 'https://demo.example.test', secret = 'whsec_SYNTHETIC';
export type Sandbox = { gymId: string; origin: string; kioskToken: string };

/** One FakePayments per sandbox stands in for the shared Stripe test account; the real test-card path is checked by hand. */
class TestPayments extends FakePayments {
  override async createCharge(input: CreateCharge) {
    const charge = await super.createCharge(input);
    this.respondNextConfirmation('succeeded');
    return charge;
  }
}

/**
 * The production runtime in demo mode over the file's database, with `count` sandboxes created through its sandbox
 * route (together, since each mostly waits on the database). The test drains the runtime's own queue instead of
 * polling it, and the seeds' payments are `TestPayments`. Read `sandbox` (the first) and `other` (the second) in the tests.
 */
export function useSandboxRuntime(db: TestDatabase, count: number) {
  const gateways = new Map<string, FakePayments>();
  const queues: PostgresJobs[] = [];
  let runtime: Runtime, storage: Awaited<ReturnType<typeof s3Server>>, directory: string, sandboxes: Sandbox[] = [];
  beforeAll(async () => {
    vi.spyOn(PostgresJobs.prototype, 'start').mockImplementation(function (this: PostgresJobs) { queues.push(this); return { async stop() {} }; });
    // The seeds resolve the gym key from the process environment, as in production.
    vi.stubEnv('APP_ENCRYPTION_KEY', 'ab'.repeat(32));
    vi.spyOn(seedPayments, 'billingSeedPayments').mockImplementation(({ gymId }) => {
      let payments = gateways.get(gymId);
      if (!payments) gateways.set(gymId, payments = new TestPayments(gymId, clock, secret));
      const owned = payments;
      return { gymId, mode: 'test', payments: owned, async seedCard(customerId) {
        const id = 'pm_' + uuidv7().replaceAll('-', '');
        owned.recordPaymentMethod({ id, customerId, last4: '4242', expiresMonth: 12, expiresYear: 2030 });
        return id;
      } };
    });
    storage = await s3Server();
    directory = await mkdtemp(join(tmpdir(), 'demo-portal-runtime-'));
    runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'demo-portal-runtime-secret-with-32-characters',
      TENANCY: 'multi', DEMO_MODE: 'true', DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: install, NODE_ENV: 'production',
      DEMO_STRIPE_TEST_KEY: 'rk_test_SYNTHETIC', DEMO_STRIPE_WEBHOOK_SECRET: secret,
      UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: storage.endpoint, UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
      BACKUP_STAGING_DIR: join(directory, 'staging') });
    // The route allows a few creations per client address and hour, so a file asks for no more than that.
    const create = async () => {
      const response = await send(install, '/api/demo/sandboxes', { body: {} });
      if (response.status !== 201) throw new Error(`Sandbox creation answered ${response.status}: ${await response.text()}`);
      return (await response.json()).data as Sandbox;
    };
    sandboxes = await Promise.all(Array.from({ length: count }, create));
  }, 180_000);
  afterAll(async () => {
    await runtime?.stop(); await storage?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  async function drain() {
    const [queue] = queues;
    for (let count = 0; count < 200; count++) if (!await queue!.runNext()) return;
    throw new Error('Job drain exceeded its bound');
  }
  function send(base: string, path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
    return runtime.app.request(base + path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { host: new URL(base).host, origin: base, ...(init.body === undefined ? {} : { 'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(JSON.stringify(init.body))) }),
        ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
  }
  /** The kiosk picks the one booked current class, or offers a choice; the visitor then taps open mat. */
  async function checkIn(target: Sandbox, code: string) {
    const scan = (body: unknown) => send(target.origin, '/api/kiosk/checkin/qr', { body, headers: { authorization: `Bearer ${target.kioskToken}` } });
    let result = (await (await scan({ code })).json()).data as { status: string; member?: { id: string } };
    if (result.status === 'select_session') result = (await (await scan({ code, sessionId: null })).json()).data;
    return result;
  }
  const sandboxAt = (index: number) => sandboxes[index] ?? (() => { throw new Error(`The file created ${sandboxes.length} sandboxes, not ${index + 1}`); })();
  return { gateways, send, drain, checkIn, get runtime() { return runtime; }, get sandbox() { return sandboxAt(0); }, get other() { return sandboxAt(1); } };
}
export const cookiesOf = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

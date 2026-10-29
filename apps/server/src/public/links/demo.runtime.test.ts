// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, paymentMethods, waiverSignatures, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { startRuntime } from '../../core/runtime.js';
import { clock } from '../../core/clock.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import * as stripeAdapter from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { s3Server } from '../../infra/storage/s3-server.test-helper.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { demoSignatureReservation } from '../../demo/waiver-signatures.js';

const db = useTestDatabase(), factory = createFactories(db);
it('completes card and waiver onboarding through the demo production runtime with its real upload restrictions', async () => {
  const gymId = uuidv7(), hostname = gymId + '.demo.example.test', origin = 'https://' + hostname;
  const expiresAt = new Date(clock.now().getTime() + 86_400_000).toISOString();
  await factory('gyms', gymId, { settings: { setupComplete: true, demo: { sandbox: true, ready: true, expiresAt } } });
  await factory('gymDomains', gymId, { hostname, kind: 'default' });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const member = await factory('members', gymId, { householdId: household.id, dateOfBirth: '1990-01-01' });
  const template = await factory('waiverTemplates', gymId);
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const link = await links.create({ gymId, actor: { kind: 'system' } }, { purpose: 'onboarding', householdId: household.id, expiresAt });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000));
  const payments = vi.spyOn(stripeAdapter, 'stripeTransport').mockReturnValue(transport);
  const worker = vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const storage = await s3Server(), directory = await mkdtemp(join(tmpdir(), 'plaingym-demo-waiver-runtime-'));
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
      AUTH_SECRET: 'runtime-secret-with-at-least-32-characters', TENANCY: 'multi', DEMO_MODE: 'true',
      DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: 'https://demo.example.test', NODE_ENV: 'production',
      DEMO_STRIPE_TEST_KEY: 'rk_test_runtime', DEMO_STRIPE_WEBHOOK_SECRET: 'whsec_runtime',
      UPLOADS_S3_BUCKET: 'demo', UPLOADS_S3_ENDPOINT: storage.endpoint, UPLOADS_S3_REGION: 'us-east-1',
      UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
      BACKUP_STAGING_DIR: directory, BACKUP_STATE_DIR: directory });
    const app = runtime.app, path = '/api/links/onboarding';
    const post = (suffix: string, body: unknown = {}, cookie = '') => app.request(origin + path + suffix, {
      method: 'POST', body: JSON.stringify(body), headers: { host: hostname, origin, 'sec-fetch-site': 'same-origin',
        authorization: 'Bearer ' + link.token, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    });
    const started = await post('/checkout'); expect(started.status).toBe(200);
    const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
    const session = [...transport.objects.values()].find(row => row.object === 'checkout.session')!;
    transport.completeCheckout(String(session.id));
    expect(await (await post('/complete', {}, cookie)).json()).toEqual({ data: { completed: false } });
    const upload = await post('/signature-images', { memberId: member.id, pngBase64: demoSignaturePng().toString('base64') }, cookie);
    expect(upload.status).toBe(200);
    const image = (await upload.json()).data;
    const signed = await post('/waivers', { memberId: member.id, templateId: template.id, templateVersion: template.version,
      ...image, consent: true, signer: { kind: 'self', name: 'Test Payer' } }, cookie);
    expect(signed.status).toBe(200);
    expect(await (await post('/complete', {}, cookie)).json()).toEqual({ data: { completed: true } });
    const page = await app.request(origin + '/l/' + link.token, { headers: { host: hostname } });
    expect(page.status).toBe(200); expect(await page.text()).toContain('Already done');
    expect(await db.forGym(gymId, tx => tx.$count(waiverSignatures, eq(waiverSignatures.memberId, member.id)))).toBe(1);
    expect(await db.forGym(gymId, tx => tx.$count(paymentMethods, eq(paymentMethods.householdId, household.id)))).toBe(1);
    expect(await db.forGym(gymId, tx => tx.$count(auditEvents, eq(auditEvents.action, demoSignatureReservation)))).toBe(1);
  } finally {
    await runtime?.stop(); payments.mockRestore(); worker.mockRestore();
    await storage.close(); await rm(directory, { recursive: true, force: true });
  }
});

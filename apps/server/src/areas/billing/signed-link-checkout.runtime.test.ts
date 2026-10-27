// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { portalSignedLinkDataSchema, type SignedLinkPurposeName } from '@plaingym/shared/contracts';
import { startRuntime } from '../../core/runtime.js';
import { clock } from '../../core/clock.js';
import { FakePayments, type CheckoutSession, type Payments } from '../../infra/payments/index.js';
import { StripePayments } from '../../infra/payments/stripe.js';
import { StripeFixtures } from '../../infra/payments/stripe-fixtures.js';
import { FixtureRecorder, type Tape } from '../../infra/payments/recording.js';
import { recordingTransport, replayTransport } from '../../infra/payments/transport.js';
import { PostgresJobs } from '../../infra/jobs/postgres.js';
import type { JobHandler } from '../../infra/jobs/index.js';
import * as stripeStep from '../setup/stripe-step.js';
import { createSignedLinksService } from '../links/service.js';
import { createKioskDeviceService } from '../kiosk/devices.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';

const db = useTestDatabase(), factory = createFactories(db);
it('routes all browser link actions and webhook completion through startRuntime while keeping kiosk tokens scoped', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId, { billingEnabled: true });
  const household = await factory('households', gymId, { stripeCustomerId: 'cus_fixture' });
  const fake = new FakePayments(gymId, clock, 'synthetic-runtime-secret');
  fake.seedCustomer({ id: 'cus_fixture', email: 'payer@example.test' });
  const transport = new StripeFixtures(gymId, Math.floor(clock.now().getTime() / 1000), 1000);
  let provider: Payments = fake;
  const handlers = new Map<string, JobHandler>();
  // Runtime consumes the Payments contract; exercise both implementations at this resolver boundary.
  const resolve = vi.spyOn(stripeStep, 'createPaymentsResolver').mockReturnValue(async () => provider as StripePayments);
  const register = PostgresJobs.prototype.handle;
  const handle = vi.spyOn(PostgresJobs.prototype, 'handle').mockImplementation(function (this: PostgresJobs, name, handler) {
    handlers.set(name, handler); register.call(this, name, handler);
  });
  const worker = vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-r8-'));
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    const origin = 'https://gym.example.test', secret = 'synthetic-runtime-secret';
    runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32),
      AUTH_SECRET: 'runtime-secret-with-at-least-32-characters', TENANCY: 'single', PUBLIC_ORIGIN: origin,
      NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'on', UPLOADS_DIR: directory });
    const app = runtime.app, links = createSignedLinksService({ scope: db.forGym, clock });
    const mutation = { gymId, actor: { kind: 'system' as const } };
    let invoiceNumber = 0;
    async function createLink(purpose: SignedLinkPurposeName) {
      const resource = purpose === 'pay_invoice'
        ? { purpose, invoiceId: (await factory('invoices', gymId, { householdId: household.id,
          number: ++invoiceNumber, status: 'open', amountCents: 100 })).id }
        : purpose === 'sign_waiver' ? { purpose, memberId: (await factory('members', gymId, { householdId: household.id })).id }
          : { purpose };
      return links.create(mutation, { ...resource, householdId: household.id,
        expiresAt: new Date(clock.now().getTime() + 86400000).toISOString() });
    }
    // Match browser.ts and browser-added Origin/fetch headers, including the return cookie.
    const post = (path: string, token: string, body: unknown = {}, cookie = '', extra: Record<string, string> = {}) =>
      app.request(origin + path, { method: 'POST', body: JSON.stringify(body),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-link-tablet': 'true',
          origin, 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...extra } });
    async function dispatch(session: CheckoutSession, stripe: boolean) {
      const eventId = 'evt_' + uuidv7(), type = session.mode === 'setup' ? 'setup_intent.succeeded' : 'checkout.session.completed';
      const objectId = session.mode === 'setup' ? session.setupId! : session.id;
      const event = stripe ? { id: eventId, object: 'event', type, livemode: false,
        data: { object: { id: objectId, object: session.mode === 'setup' ? 'setup_intent' : 'checkout.session', metadata: { gym_id: gymId } } } }
        : { id: eventId, type, gymId, objectId, objectKind: session.mode === 'setup' ? 'setup' : 'checkout' };
      const body = JSON.stringify(event), timestamp = Math.floor(clock.now().getTime() / 1000);
      const signature = stripe ? 't=' + timestamp + ',v1=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex')
        : fake.signWebhook(new TextEncoder().encode(body));
      expect((await app.request(origin + '/webhooks/stripe', { method: 'POST', body, headers: { 'stripe-signature': signature } })).status).toBe(200);
      await handlers.get('billing.webhooks.dispatch')!({ eventId }, { gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
    }
    async function sign(token: string, purpose: 'onboarding' | 'sign_waiver', cookie = '') {
      const path = '/api/links/' + purpose.replaceAll('_', '-');
      const response = await app.request(origin + path, { headers: { authorization: 'Bearer ' + token } });
      expect(response.status).toBe(200);
      const data = portalSignedLinkDataSchema.parse((await response.json()).data);
      if (data.purpose !== 'onboarding' && data.purpose !== 'sign_waiver') throw new Error('Expected waiver link');
      for (const member of data.purpose === 'onboarding' ? data.members : [data.member]) for (const template of data.templates) {
        if (data.signatures.some(s => s.memberId === member.id && s.templateId === template.id)) continue;
        const target = purpose === 'onboarding' ? { memberId: member.id } : {};
        const image = await post(path + '/signature-images', token, { ...target, pngBase64: demoSignaturePng().toString('base64') }, cookie);
        expect(image.status).toBe(200);
        const signed = await post(path + (purpose === 'onboarding' ? '/waivers' : ''), token,
          { ...target, ...(await image.json()).data, templateId: template.id, templateVersion: template.version, consent: true,
            signer: { kind: 'guardian', name: 'Payer', relationship: 'Parent' } }, cookie);
        expect(signed.status).toBe(200);
      }
    }
    for (const stripe of [false, true]) {
      provider = stripe ? new StripePayments(gymId, { clock, transport, webhookSecret: secret }) : fake;
      const create = vi.spyOn(provider, 'createCheckout');
      try {
        for (const purpose of ['pay_invoice', 'update_card', 'onboarding'] as const) {
          if (purpose === 'onboarding') {
            await factory('members', gymId, { householdId: household.id });
            await factory('waiverTemplates', gymId);
          }
          const link = await createLink(purpose), path = '/api/links/' + purpose.replaceAll('_', '-');
          const started = await post(path + '/checkout', link.token);
          expect(started.status).toBe(200);
          const cookie = started.headers.get('set-cookie')!.split(';')[0]!;
          const session = await create.mock.results.at(-1)!.value as CheckoutSession;
          const pending = await post(path + '/complete', link.token, {}, cookie);
          expect(pending.status).toBe(200); expect(await pending.json()).toEqual({ data: { completed: false } });
          expect((await post(path + '/complete', link.token, {}, cookie,
            { origin: 'https://other.test', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
          let finished = session;
          if (stripe) transport.completeCheckout(session.id);
          else finished = fake.completeCheckout(session.id);
          await dispatch(finished, stripe);
          if (purpose === 'onboarding') {
            expect((await links.resolve(gymId, link.token)).status).toBe('active');
            await sign(link.token, purpose, cookie);
            const complete = await post(path + '/complete', link.token, {}, cookie);
            expect(complete.status).toBe(200); expect(await complete.json()).toEqual({ data: { completed: true } });
          }
          // Payment and update-card finish through HTTP start and webhook dispatch alone.
          expect((await links.resolve(gymId, link.token)).status).toBe('used');
        }
        const waiver = await createLink('sign_waiver');
        await sign(waiver.token, 'sign_waiver');
        expect((await links.resolve(gymId, waiver.token)).status).toBe('used');
      } finally { create.mockRestore(); }
    }
    const kiosk = await createKioskDeviceService({ scope: db.forGym, clock }).register(mutation, { name: 'Runtime kiosk' });
    const pending = await createLink('update_card');
    expect((await post('/api/kiosk/lookup', kiosk.token, { name: 'Nobody', pin: '1234' })).status).toBe(200);
    for (const token of [kiosk.token, pending.token, 'unknown']) for (const path of ['/api/settings', '/api/portal/context', '/api/auth/get-session', '/api/kiosk/devices'])
      expect((await post(path, token)).status).toBe(404);
    expect((await post('/api/kiosk/lookup', pending.token, { name: 'Nobody', pin: '1234' })).status).toBe(404);
    for (const path of ['/api/links/update-card', '/api/links/update-card/checkout', '/api/links/update-card/complete'])
      expect((await post(path, kiosk.token)).status).toBe(404);

    // Record/replay a full HTTP card update without a return visit or Checkout service calls.
    const link = await createLink('update_card'), location = new URL('./signed-link-checkout.runtime.synthetic.json', import.meta.url);
    const recording = process.env.RECORD_LINK_CHECKOUT_FIXTURES === '1', recorder = new FixtureRecorder(gymId);
    const ids = [gymId, link.link.id], placeholders = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000003'];
    const bind = (body: string, replay: boolean) => ids.reduce((text, id, index) =>
      replay ? text.replaceAll(placeholders[index]!, id) : text.replaceAll(id, placeholders[index]!), body);
    const replay = recording ? undefined : replayTransport(JSON.parse(bind(await readFile(location, 'utf8'), true)) as Tape, gymId);
    const fixture = new StripeFixtures(gymId, 1793102400, 2000);
    provider = new StripePayments(gymId, { clock, webhookSecret: secret, transport: replay ?? recordingTransport(fixture, recorder) });
    const create = vi.spyOn(provider, 'createCheckout');
    try {
      const started = await post('/api/links/update-card/checkout', link.token);
      expect(started.status).toBe(200);
      const session = await create.mock.results[0]!.value as CheckoutSession;
      if (recording) fixture.completeCheckout(session.id);
      await dispatch(session, true);
      expect((await links.resolve(gymId, link.token)).status).toBe('used');
      expect((await db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, link.link.id))))
        .filter(audit => audit.action === 'signed_link.used')).toHaveLength(1);
      if (recording) await writeFile(location, bind(JSON.stringify({
        $comment: 'SPDX-License-Identifier: AGPL-3.0-only; synthetic Stripe API exchanges, no real account', ...recorder.tape,
      }, null, 2), false) + '\n');
      else replay!.assertConsumed();
    } finally { create.mockRestore(); }
  } finally {
    await runtime?.stop(); resolve.mockRestore(); handle.mockRestore(); worker.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

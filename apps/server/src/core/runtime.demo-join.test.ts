// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
// eslint-disable-next-line database/system-tables -- Assembly test turns on the sandbox's billing switch.
import { gyms, waiverTemplates } from '@plaingym/db';
import { demoSignaturePng } from '../demo/seed/waivers-image.js';
import { demoStripeEnv, useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;

/** Joins in the sandbox through the JSON steps and returns the continuation cookie of the pending join. */
async function startJoin() {
  const sandbox = app.sandbox;
  const plan = await app.factory('plans', sandbox.gymId, { name: 'Runtime monthly', amountCents: 12000, interval: 'monthly' });
  // The sandbox's seeded waivers: the join must sign every current one.
  const templates = await database.forGym(sandbox.gymId, tx => tx.select().from(waiverTemplates));
  const person = { firstName: 'Riley', lastName: 'Joiner', dateOfBirth: '1991-05-06' }, contact = { name: 'Riley Joiner', email: 'riley@example.invalid' };
  const admission = await app.post('/join/signatures', { planId: plan.id, contact, honeypot: '', members: [{ member: person,
    signatures: templates.map(template => ({ templateId: template.id, templateVersion: template.version, pngBase64: demoSignaturePng().toString('base64') })) }] }, sandbox.origin);
  expect(admission.status, await admission.clone().text()).toBe(200);
  const images = (await admission.json()).data as Record<string, unknown>[][];
  const submitted = await app.post('/api/public/join', { planId: plan.id, contact, honeypot: '', members: [{ member: person,
    waivers: images[0]!.map(image => ({ ...image, consent: true, signer: { kind: 'self', name: 'Riley Joiner' } })) }] }, sandbox.origin);
  expect(submitted.status, await submitted.clone().text()).toBe(200);
  return app.cookieOf(submitted);
}

it('names the test card on the join page steps that lead to payment, through the runtime', async () => {
  await app.restart(demoStripeEnv);
  const sandbox = app.sandbox;
  await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ billingEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  const cookie = await startJoin();
  const get = async (path: string) => {
    const response = await app.runtime.app.request(sandbox.origin + path, { headers: app.headers(sandbox, cookie) });
    return { status: response.status, body: await response.text() };
  };
  const cancelled = await get('/join/cancelled');
  expect(cancelled.status).toBe(200);
  expect(cancelled.body).toContain('Demo payment: use the test card 4242 4242 4242 4242');
  // The page that waits for the webhook doesn't lead to payment.
  const confirming = await get('/join/return');
  expect(confirming.status).toBe(200);
  expect(confirming.body).not.toContain('4242');
});

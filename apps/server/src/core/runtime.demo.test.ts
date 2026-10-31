// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects install cleanup jobs and gym settings in real PostgreSQL.
import { emailOutbox, gyms, householdUsers, jobs, kioskDevices, programs } from '@plaingym/db';
import { SmtpEmail } from '../infra/email/index.js';
import { createSignedLinksService } from '../areas/links/service.js';
import { atomicJson } from '../areas/health/backups.files.js';
import { origin, useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;

it('serves the demo entry and creates sandboxes before tenant resolution, with setup disabled', async () => {
  const sandbox = app.sandbox;
  const discovery = await app.runtime.app.request(origin + '/api/demo');
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toEqual({ data: { mode: 'entry' } });
  const status = await app.runtime.app.request(sandbox.origin + '/api/demo', { headers: app.headers(sandbox) });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ data: { mode: 'sandbox', expiresAt: expect.any(String) } });
  expect((await app.runtime.app.request('https://unknown.example.test/api/demo')).status).toBe(404);
  expect((await app.post('/api/setup/owner', {}, sandbox.origin)).status).toBe(404);
  expect((await app.runtime.app.request(sandbox.origin + '/api/setup', { headers: app.headers(sandbox) })).status).toBe(404);
  expect((await database.forGym(sandbox.gymId, (tx) => tx.select().from(programs))).length).toBeGreaterThan(0);
  expect((await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'demo.expire'))))).toHaveLength(1);
});
it('routes real login and signed-link email into the outbox without SMTP', async () => {
  const sandbox = app.sandbox;
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const cookie = await app.login('owner');
  expect((await app.runtime.app.request(sandbox.origin + '/api/auth/bootstrap', { headers: app.headers(sandbox, cookie) })).status).toBe(200);
  expect((await app.post('/api/auth/sign-in/magic-link', { email: `owner.${sandbox.gymId}@example.invalid`, callbackURL: '/admin' }, sandbox.origin)).status).toBe(200);
  const [household] = await database.forGym(sandbox.gymId, (tx) => tx.select().from(householdUsers));
  await database.forGym(sandbox.gymId, (tx) => tx.update(gyms).set({ memberEmailsEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  await createSignedLinksService().send({ gymId: sandbox.gymId, actor: { kind: 'system' } }, {
    purpose: 'update_card', householdId: household!.householdId, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const messages = await database.forGym(sandbox.gymId, (tx) => tx.select().from(emailOutbox));
  expect(messages).toHaveLength(2);
  expect(messages.some((message) => message.text.includes(sandbox.origin + '/l/'))).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
it('separates real member and staff sessions through the runtime composition', async () => {
  const sandbox = app.sandbox, ownerCookie = await app.login('owner');
  const headers = app.headers(sandbox, await app.login('student'));
  const context = await app.runtime.app.request(sandbox.origin + '/api/portal/context', { headers });
  expect(context.status).toBe(200);
  expect(await context.json()).toMatchObject({ data: { role: 'payer', householdId: expect.any(String) } });
  for (const path of ['/api/staff/profiles', '/api/settings/go-live', '/api/dashboard']) {
    expect((await app.runtime.app.request(sandbox.origin + path, { headers })).status, path).toBe(403);
  }
  expect((await app.runtime.app.request(sandbox.origin + '/api/portal/context', {
    headers: { ...headers, cookie: ownerCookie },
  })).status).toBe(404);
});
it('uses kiosk authentication ahead of sessions and blocks uploads in the running demo', async () => {
  const sandbox = app.sandbox, headers = { authorization: `Bearer ${sandbox.kioskToken}` };
  await app.post('/api/kiosk/lookup', { name: 'Alex', pin: '1234' }, sandbox.origin, headers);
  const [device] = await database.forGym(sandbox.gymId, (tx) => tx.select().from(kioskDevices));
  expect(device!.lastSeenAt).not.toBeNull();
  expect((await app.runtime.app.request(sandbox.origin + '/api/settings', { headers: { ...app.headers(sandbox), ...headers } })).status).toBe(404);
  await expect((await app.runtime.uploadsFor(sandbox.gymId)).put(sandbox.gymId + '/photo', new Uint8Array([1]), 'image/png')).rejects.toMatchObject({ code: 'forbidden' });
});
it('keeps install sandbox creation behind the restore gate', async () => {
  await atomicJson(join(app.directory, 'restore-state.json'), { phase: 'database' });
  try { expect((await app.post('/api/demo/sandboxes', {})).status).toBe(503); }
  finally { await atomicJson(join(app.directory, 'restore-state.json'), { phase: 'complete' }); }
});
it('serves friendly missing links and a present browser asset through the runtime', async () => {
  const headers = app.headers(app.sandbox);
  const missing = await app.runtime.app.request(app.sandbox.origin + '/l/' + 'x'.repeat(43), { headers });
  expect(missing.status).toBe(404); expect(missing.headers.get('content-type')).toContain('text/html');
  expect(await missing.text()).not.toContain('not configured');
  await mkdir(join(app.directory, 'public'), { recursive: true });
  await writeFile(join(app.directory, 'public', 'links.js'), 'document.documentElement.dataset.runtimeAsset = "loaded";');
  const previous = process.cwd();
  try {
    process.chdir(app.directory);
    const script = await app.runtime.app.request(app.sandbox.origin + '/l/client.js', { headers });
    expect(script.status).toBe(200); expect(script.headers.get('content-type')).toContain('javascript');
    expect(await script.text()).toContain('runtimeAsset');
  } finally { process.chdir(previous); }
});

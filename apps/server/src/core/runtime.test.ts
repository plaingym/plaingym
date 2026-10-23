// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Assembly test inspects install cleanup jobs and gym email switches in real PostgreSQL.
import { emailOutbox, gyms, households, householdUsers, jobs, kioskDevices, programs, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { startRuntime, runCommandLine, type Runtime } from './runtime.js';
import { SmtpEmail } from '../infra/email/index.js';
import { createSignedLinksService } from '../areas/links/service.js';
import { atomicJson } from '../areas/health/backups.files.js';

const database = useTestDatabase();
const origin = 'https://demo.example.test';
let runtime: Runtime, directory: string;
let sandbox: { gymId: string; origin: string; kioskToken: string };
const env = () => ({ DATABASE_URL: database.appUrl, APP_ENCRYPTION_KEY: 'ab'.repeat(32), AUTH_SECRET: 'runtime-secret-with-at-least-32-characters',
  TENANCY: 'multi', DEMO_MODE: 'true', DEMO_DOMAIN: 'demo.example.test', PUBLIC_ORIGIN: origin, NODE_ENV: 'production',
  UPLOADS_S3_BUCKET: 'demo-uploads', UPLOADS_S3_ENDPOINT: 'http://127.0.0.1:1',
  UPLOADS_S3_ACCESS_KEY_ID: 'test', UPLOADS_S3_SECRET_ACCESS_KEY: 'test',
  // Invalid SMTP would fail immediately if demo startup constructed a resolver.
  SMTP_HOST: 'never-connect.invalid', SMTP_SECURITY: 'invalid',
  BACKUP_STAGING_DIR: join(directory, 'staging') });
const post = (path: string, body: unknown, base = origin, extra: Record<string, string> = {}) => runtime.app.request(base + path, {
  method: 'POST', headers: { host: new URL(base).host, origin: base, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'runtime-demo-'));
  runtime = await startRuntime(env());
});
afterAll(async () => { await runtime?.stop(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('refuses live keys before trying to open a database', async () => {
  await expect(startRuntime({ ...env(), DATABASE_URL: 'invalid', STRIPE_KEY: 'sk_live_forbidden' })).rejects.toThrow(/live/);
});
it('reprints the setup link without requiring a database connection', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() }, token = 'private-installer-token-at-least-32-characters';
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin, SETUP_TOKEN: token })).toBe(0);
  expect(io.stdout).toHaveBeenCalledWith(origin + '/setup#token=' + token);
  expect(await runCommandLine(['setup-link'], io, { PUBLIC_ORIGIN: origin })).toBe(1);
});
it('serves the demo entry and creates sandboxes before tenant resolution, with setup disabled', async () => {
  expect((await runtime.app.request(origin + '/api/demo')).status).toBe(200);
  const response = await post('/api/demo/sandboxes', {});
  expect(response.status).toBe(201);
  sandbox = (await response.json()).data;
  expect((await runtime.app.request(sandbox.origin + '/api/demo', { headers: { host: new URL(sandbox.origin).host } })).status).toBe(404);
  expect((await post('/api/setup/owner', {}, sandbox.origin)).status).toBe(404);
  expect((await runtime.app.request(sandbox.origin + '/api/setup', { headers: { host: new URL(sandbox.origin).host } })).status).toBe(404);
  expect((await database.forGym(sandbox.gymId, (tx) => tx.select().from(programs))).length).toBeGreaterThan(0);
  expect((await database.forSystem((tx) => tx.select().from(jobs).where(eq(jobs.name, 'demo.expire'))))).toHaveLength(1);
});
it('routes real login and signed-link email into the outbox without SMTP', async () => {
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  expect((await runtime.app.request(sandbox.origin + '/api/auth/bootstrap', { headers: { host: new URL(sandbox.origin).host, cookie } })).status).toBe(200);
  expect((await post('/api/auth/sign-in/magic-link', { email: `owner.${sandbox.gymId}@example.invalid`, callbackURL: '/admin' }, sandbox.origin)).status).toBe(200);
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
it('serves rank and import routes through the runtime composition', async () => {
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  // Ranks answer 503 until configured with attendance queries.
  expect((await runtime.app.request(sandbox.origin + '/api/programs', { headers })).status).toBe(200);
  // Import and export routes exist only when composed with storage and the job queue.
  const document = await (await runtime.app.request(sandbox.origin + '/api/openapi.json', { headers })).json() as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/imports/uploads', '/api/exports']));
  // Household PINs hash with the gym's own key once the runtime composes members.
  const homeId = uuidv7();
  await database.forGym(sandbox.gymId, (tx) => tx.insert(households).values({ id: homeId, gymId: sandbox.gymId, name: 'PIN family' }));
  const pin = await runtime.app.request(sandbox.origin + '/api/households/' + homeId + '/pin', { method: 'PUT',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, pin: '2468' }) });
  expect(pin.status).toBe(200);
  const [stored] = await database.forGym(sandbox.gymId, (tx) => tx.select({ pinHash: households.pinHash }).from(households).where(eq(households.id, homeId)));
  expect(stored!.pinHash).toMatch(/^[a-f0-9]{64}$/);
});
it('serves staff, dashboard, and go-live routes through the runtime composition', async () => {
  const login = await post('/api/demo/login', { role: 'owner' }, sandbox.origin);
  const cookie = login.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  const headers = { host: new URL(sandbox.origin).host, cookie };
  // Each answers 503 until the runtime configures it.
  for (const path of ['/api/staff/profiles', '/api/dashboard', '/api/settings/go-live'])
    expect((await runtime.app.request(sandbox.origin + path, { headers })).status, path).toBe(200);
  // Demo invitations go to the in-app outbox; printed ones return a link on the gym's own origin.
  const invite = await runtime.app.request(sandbox.origin + '/api/staff/invitations', { method: 'POST',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new.coach@example.invalid', role: 'coach', delivery: 'print' }) });
  expect(invite.status).toBe(200);
  const { data } = await invite.json() as { data: { invitationUrl: string } };
  expect(new URL(data.invitationUrl).origin).toBe(sandbox.origin);
});
it('uses kiosk authentication ahead of sessions and blocks uploads in the running demo', async () => {
  const headers = { authorization: `Bearer ${sandbox.kioskToken}` };
  await post('/api/kiosk/lookup', { name: 'Alex', pin: '1234' }, sandbox.origin, headers);
  const [device] = await database.forGym(sandbox.gymId, (tx) => tx.select().from(kioskDevices));
  expect(device!.lastSeenAt).not.toBeNull();
  expect((await runtime.app.request(sandbox.origin + '/api/settings', { headers: { host: new URL(sandbox.origin).host, ...headers } })).status).toBe(404);
  await expect((await runtime.uploadsFor(sandbox.gymId)).put(sandbox.gymId + '/photo', new Uint8Array([1]), 'image/png')).rejects.toMatchObject({ code: 'forbidden' });
});
it('keeps install sandbox creation behind the restore gate', async () => {
  await atomicJson(join(directory, 'restore-state.json'), { phase: 'database' });
  try { expect((await post('/api/demo/sandboxes', {})).status).toBe(503); }
  finally { await atomicJson(join(directory, 'restore-state.json'), { phase: 'complete' }); }
});
it('registers seed in the real CLI', async () => {
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  await runtime.stop();
  expect(await runCommandLine(['seed', sandbox.gymId], io, env())).toBe(0);
  expect(io.stdout).toHaveBeenCalledWith('Seed complete');
});

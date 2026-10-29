// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Runtime composition test configures encrypted gym SMTP in real PostgreSQL.
import { gyms, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { SmtpEmail } from '../infra/email/index.js';
import { PostgresJobs } from '../infra/jobs/postgres.js';
import { encryptSmtpConfig } from '../areas/settings/smtp.js';
import { demoSignaturePng } from '../demo/seed/waivers-image.js';
import { parseEncryptionKey } from './secrets.js';
import { setLogSink } from './log.js';
import { startRuntime, type Runtime } from './runtime.js';

const db = useTestDatabase(), factory = createFactories(db), gymId = uuidv7();
const origin = 'https://gym.example.test', key = 'ab'.repeat(32);
let runtime: Runtime, directory: string, template: { id: string; version: number };
const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail');
const input = () => ({ contact: { name: 'Private Contact', email: 'visitor@example.invalid', phone: '555-0100' },
  member: { firstName: 'Private', lastName: 'Applicant', dateOfBirth: '1990-01-02' }, honeypot: '' });
const post = (path: string, body: unknown) => runtime.app.request(origin + path, {
  method: 'POST', headers: { host: 'gym.example.test', origin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function submit(kind: 'trial' | 'drop-in') {
  const body = input();
  if (kind === 'trial') return post('/api/public/trial', body);
  const admission = await post('/drop-in/signatures', { ...body,
    signatures: [{ templateId: template.id, templateVersion: template.version, pngBase64: demoSignaturePng().toString('base64') }] });
  expect(admission.status, await admission.clone().text()).toBe(200);
  const { data } = await admission.json();
  return post('/api/public/drop-in', { ...body, waivers: data.map((image: Record<string, unknown>) => ({ ...image,
    signer: { kind: 'self', name: 'Private Applicant' }, consent: true })) });
}
async function smtp(configured: boolean) {
  await db.forGym(gymId, tx => tx.update(gyms).set({ smtpConfig: configured ? encryptSmtpConfig(parseEncryptionKey(key), {
    host: 'smtp.example.invalid', port: 587, security: 'starttls', from: 'desk@example.invalid', username: 'gym', password: 'private-smtp-secret',
  }) : null }).where(eq(gyms.id, gymId)));
}
beforeAll(async () => {
  vi.spyOn(PostgresJobs.prototype, 'start').mockReturnValue({ async stop() {} });
  directory = await mkdtemp(join(tmpdir(), 'plaingym-public-runtime-'));
  await factory('gyms', gymId, { memberEmailsEnabled: false, websiteEnabled: false });
  template = await factory('waiverTemplates', gymId);
  for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) {
    const user = await factory('authUser', gymId, { email: role + '@example.invalid' });
    await factory('staffRoles', gymId, { userId: user.id, role });
  }
  runtime = await startRuntime({ DATABASE_URL: db.appUrl, APP_ENCRYPTION_KEY: key,
    AUTH_SECRET: 'public-runtime-secret-at-least-32-characters', TENANCY: 'single',
    PUBLIC_ORIGIN: origin, NODE_ENV: 'production', UPLOADS_DIR: join(directory, 'uploads') });
});
afterAll(async () => {
  await runtime?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it.each(['trial', 'drop-in'] as const)('receives %s without SMTP, records the applicant and sends no mail', async kind => {
  await smtp(false);
  const before = await db.forGym(gymId, tx => tx.select().from(members));
  const response = await submit(kind);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ data: { status: 'received' } });
  const after = await db.forGym(gymId, tx => tx.select().from(members));
  expect(after).toHaveLength(before.length + 1);
  expect(after.filter(row => !before.some(old => old.id === row.id))).toMatchObject([{ status: kind === 'trial' ? 'prospect' : 'visitor' }]);
  expect(send).not.toHaveBeenCalled();
});
it.each(['trial', 'drop-in'] as const)('still receives %s when the mailer throws, logging the request ID without visitor PII', async kind => {
  await smtp(true);
  send.mockRejectedValue(new Error('Delivery failed for visitor@example.invalid Private Applicant 555-0100'));
  const logs: string[] = [], previous = setLogSink(line => logs.push(line));
  try {
    const response = await submit(kind);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { status: 'received' } });
    expect(send).toHaveBeenCalled();
    expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      event: 'public.intake.notification_failed', requestId: response.headers.get('x-request-id'), gymId, kind,
    }));
    expect(logs.join('\n')).not.toMatch(/visitor@example|Private Applicant|Private Contact|555-0100/);
  } finally { setLogSink(previous); }
});
it('sends public intake notices only to owner/admin staff even with member emails disabled', async () => {
  await smtp(true);
  send.mockResolvedValue({ status: 'sent', messageId: 'staff-notice' });
  const response = await submit('trial');
  expect(response.status).toBe(200);
  expect(send.mock.calls.map(([message]) => message.to).sort()).toEqual(['admin@example.invalid', 'owner@example.invalid']);
  const config = await runtime.app.request(origin + '/api/public/config');
  expect((await config.json()).data.dropInFee).toBeNull();
});

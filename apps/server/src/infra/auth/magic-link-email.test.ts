// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { setLogSink } from '../../core/log.js';
import { DeliveryError, type Email } from '../email/index.js';
import { SmtpDeliveryError } from '../email/smtp.js';
import { createEmailDeliveries } from '../email/deliveries.js';
import { authConfig } from './config.js';
import { createAuthEmailSender } from './delivery.js';
import { createAuthService, emailUnavailableCode } from './service.js';

const database = useTestDatabase(), factory = createFactories(database);
const secret = 'magic-link-email-test-secret-at-least-32-characters';
const config = authConfig({ AUTH_SECRET: secret, NODE_ENV: 'production', AUTH_PASSWORD_LOGIN: 'off' }, false);
const loginRefused = () => new SmtpDeliveryError('not_accepted', 'SMTP authentication failed',
  { cause: { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed for desk@gym.example' } });
const recipientRefused = () => new SmtpDeliveryError('not_accepted', 'SMTP server refused the message envelope',
  { cause: { code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 } });
let ip = 1;
beforeAll(async () => {
  await initializeDatabase(database.appUrl);
  vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('TENANCY', 'single');
});
afterAll(async () => { await closeDatabase(); vi.unstubAllEnvs(); });

async function fixture(sendMagicLink: (data: { email: string; url: string; gymId: string }) => Promise<void>) {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  const staff = await factory('authUser', gymId, { emailVerified: true });
  await factory('staffRoles', gymId, { userId: staff.id, role: 'owner' });
  const origin = `https://${gymId}.example.test`;
  const auth = createAuthService({ config, database: () => database.system.db, sendMagicLink }).bind({ gymId, origin, clientIp: `198.51.100.${ip++}` });
  const ask = async (email: string) => {
    const response = await auth.handler(new Request(new URL('/api/auth/sign-in/magic-link', origin), { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email }) }));
    return { status: response.status, body: await response.text() };
  };
  return { gymId, auth, ask, staff: staff.email, stranger: `stranger-${uuidv7()}@example.test` };
}

describe('an email sign-in link the gym\'s sending service could not send', () => {
  it('answers 503 EMAIL_UNAVAILABLE alike for a staff address and an unknown one, without the reply', async () => {
    const asked: string[] = [];
    const f = await fixture(async ({ email }) => { asked.push(email); throw loginRefused(); });
    const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
    let staff: Awaited<ReturnType<typeof f.ask>>, unknown: Awaited<ReturnType<typeof f.ask>>;
    try {
      staff = await f.ask(f.staff);
      unknown = await f.ask(f.stranger);
    } finally { setLogSink(previous); }
    expect(staff.status).toBe(503);
    // The web sign-in page reads this exact literal.
    expect(emailUnavailableCode).toBe('EMAIL_UNAVAILABLE');
    expect(JSON.parse(staff.body)).toMatchObject({ code: 'EMAIL_UNAVAILABLE' });
    expect(unknown).toEqual(staff);
    expect(staff.body).not.toMatch(/535|5\.7\.8|desk@gym|Authentication failed/);
    // The sender is asked for both, so neither answer nor timing tells them apart.
    expect(asked).toEqual([f.staff.toLowerCase(), f.stranger]);
    const warnings = logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.event === 'auth.magic_link_email_unavailable');
    expect(warnings).toEqual([expect.objectContaining({ gymId: f.gymId, failure: 'authentication' }), expect.objectContaining({ gymId: f.gymId, failure: 'authentication' })]);
    expect(logs.join('\n')).not.toMatch(/stranger-|desk@gym|5\.7\.8/);
  });
  it('answers the same through the login-link sender and its delivery record', async () => {
    const transport: Email = { sendEmail: async () => { throw loginRefused(); } };
    const f = await fixture(createAuthEmailSender(async () => ({ host: 'smtp.gym.example', port: 587, from: 'desk@gym.example' }),
      createEmailDeliveries({ scope: database.forGym }), () => transport));
    const staff = await f.ask(f.staff), unknown = await f.ask(f.stranger);
    expect(staff.status).toBe(503);
    expect(unknown).toEqual(staff);
  });
  it('answers a refused recipient as before, and a working sender with 200', async () => {
    const refused = await fixture(async () => { throw recipientRefused(); });
    const before = await refused.ask(refused.staff);
    expect(before.status).toBe(500);
    expect(before.body).not.toContain('EMAIL_UNAVAILABLE');
    expect(await refused.ask(refused.stranger)).toEqual(before);
    const working = await fixture(async () => undefined);
    expect((await working.ask(working.staff)).status).toBe(200);
    expect(await working.ask(working.stranger)).toEqual(await working.ask(working.staff));
  });
  it('answers 500, not 503, for a delivery error the SMTP transport did not make', async () => {
    const f = await fixture(async () => { throw new DeliveryError('not_accepted', 'Email delivery could not be reserved'); });
    const answer = await f.ask(f.staff);
    expect(answer.status).toBe(500);
    expect(answer.body).not.toContain('EMAIL_UNAVAILABLE');
  });
  it('keeps the delivery error for a login link the app sends itself', async () => {
    const error = loginRefused();
    const f = await fixture(async () => { throw error; });
    await expect(f.auth.sendLoginLink(f.staff)).rejects.toBe(error);
    const other = recipientRefused();
    const g = await fixture(async () => { throw other; });
    await expect(g.auth.sendLoginLink(g.staff)).rejects.toBe(other);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakeEmail, DeliveryError } from '../../infra/email/index.js';
import { encryptSmtpConfig } from '../settings/smtp.js';
import { createAutoUpdateNotices } from './auto-update.notices.js';
import { createAutoUpdateCommand } from './auto-update.cli.js';
import type { AutoUpdateAttempt } from './auto-update.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-11-03T16:30:00Z');
const key = Buffer.alloc(32, 7), env = { APP_ENCRYPTION_KEY: key.toString('hex'), AUTH_SECRET: 'auto-update-test-secret-at-least-32-characters' };
const accounts = createAccountService(authConfig(env), () => db.system.db);
const attempt: AutoUpdateAttempt = { attemptedAt: clock.now().toISOString(), result: 'rolled_back', reason: 'health_check_failed', fromVersion: 'v1.2.3', toVersion: 'v1.2.4' };
async function fixture(smtp = true) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { name: 'Update gym', timezone: 'Australia/Sydney', memberEmailsEnabled: false,
    ...(smtp ? { smtpConfig: encryptSmtpConfig(key, gymId, { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'gym@example.test', username: 'gym', password: 'private' }) } : {}) });
  await factory('staffRoles', gymId, { role: 'owner' });
  await factory('staffRoles', gymId, { role: 'owner' });
  await factory('staffRoles', gymId, { role: 'admin' });
  const email = new FakeEmail(), configs: string[] = [];
  const build = () => createAutoUpdateNotices({ env, scope: db.forGym, clock,
    owners: id => accounts.staffEmails(id, ['owner']), transport: config => { configs.push(config.host); return email; } });
  return { gymId, email, configs, build };
}
it('emails each owner once per attempt through the gym SMTP, including after a new sender is created', async () => {
  const f = await fixture(), other = await fixture();
  await f.build()(f.gymId, attempt);
  await f.build()(f.gymId, attempt);
  expect(f.email.messages.map(message => message.to).sort()).toEqual((await accounts.staffEmails(f.gymId, ['owner'])).sort());
  expect(f.email.messages).toHaveLength(2);
  expect(f.configs).toEqual(['smtp.example.test', 'smtp.example.test']);
  expect(other.email.messages).toHaveLength(0);
  for (const mail of f.email.messages) {
    expect(mail.text).toContain('v1.2.4 was rolled back');
    expect(mail.text).toContain('Nov 4, 2026, 3:30 AM');
    expect(mail.text).toContain('Australia/Sydney');
    expect(mail.html).toContain('max-width:600px');
    expect(mail.text).toContain('owner of Update gym');
  }
  await f.build()(f.gymId, { ...attempt, attemptedAt: '2026-11-04T16:30:00Z', result: 'failed', reason: 'rollback_failed' });
  expect(f.email.messages).toHaveLength(4);
  expect(f.email.messages[2]!.text).toContain('docker compose ps');
});
it('does not send without SMTP, for successful or skipped updates, or in multi mode', async () => {
  const missing = await fixture(false), f = await fixture();
  await missing.build()(missing.gymId, attempt);
  await f.build()(f.gymId, { ...attempt, result: 'updated', reason: null });
  await f.build()(f.gymId, { ...attempt, result: 'skipped', reason: 'pull_failed' });
  await createAutoUpdateNotices({ env: { ...env, TENANCY: 'multi' }, transport: () => { throw new Error('Must not create transport'); } })(f.gymId, attempt);
  expect(missing.email.messages).toHaveLength(0);
  expect(f.email.messages).toHaveLength(0);
});
it('retries a definite non-send but never repeats a possibly accepted notice', async () => {
  const f = await fixture(), send = f.build();
  f.email.respondNext(new DeliveryError('not_accepted', 'Disconnected'));
  await expect(send(f.gymId, attempt)).rejects.toThrow();
  await send(f.gymId, attempt);
  expect(f.email.messages).toHaveLength(2);
  const next = { ...attempt, attemptedAt: '2026-11-05T16:30:00Z' };
  f.email.respondNext(new DeliveryError('unknown', 'Lost reply'));
  await expect(send(f.gymId, next)).rejects.toThrow();
  await send(f.gymId, next);
  // The uncertain recipient is skipped, while the other owner still receives a notice.
  expect(f.email.messages).toHaveLength(3);
});
it('sends through the host record command and deduplicates concurrent replays', async () => {
  const f = await fixture(), notify = f.build();
  const command = createAutoUpdateCommand({ env, clock, scope: db.forGym, resolveGymId: async () => f.gymId,
    restoring: async () => false, notify });
  const errors: string[] = [], io = { stdout: () => {}, stderr: (message: string) => { errors.push(message); } };
  const args = ['record', '--at', attempt.attemptedAt, '--result', 'rolled_back', '--reason', 'health_check_failed', '--from', 'v1.2.3', '--to', 'v1.2.4'];
  const results = await Promise.all([command.run(args, io), command.run(args, io)]);
  expect(results).toContain(0);
  expect(await command.run(args, io)).toBe(0);
  expect(f.email.messages).toHaveLength(2);
});

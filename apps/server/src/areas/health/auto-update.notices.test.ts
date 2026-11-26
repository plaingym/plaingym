// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { auditEvents, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- The interleaving test's backend-pid and lock-wait probes only.
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createAccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { FakeEmail, DeliveryError } from '../../infra/email/index.js';
import { encryptSmtpConfig } from '../settings/smtp.js';
import { createAutoUpdateNotices, type AutoUpdateNoticeOptions } from './auto-update.notices.js';
import { createAutoUpdateCommand } from './auto-update.cli.js';
import { autoUpdateAttemptAction, autoUpdateChangeAction, createAutoUpdateAttempts, type AutoUpdateAttempt } from './auto-update.js';

const db = useTestDatabase(), factory = createFactories(db);
const clock = new TestClock('2026-11-03T16:30:00Z');
const key = Buffer.alloc(32, 7), env = { APP_ENCRYPTION_KEY: key.toString('hex'), AUTH_SECRET: 'auto-update-test-secret-at-least-32-characters' };
const accounts = createAccountService(authConfig(env), () => db.system.db);
const attempt: AutoUpdateAttempt = { attemptedAt: clock.now().toISOString(), result: 'rolled_back', reason: 'health_check_failed', fromVersion: 'v1.2.3', toVersion: 'v1.2.4' };
async function fixture(smtp = true, overrides: { timezone?: string; branding?: unknown; smtpConfig?: string } = {}) {
  const gymId = uuidv7();
  await factory('gyms', gymId, { name: 'Update gym', timezone: 'Australia/Sydney', memberEmailsEnabled: false,
    ...(smtp ? { smtpConfig: encryptSmtpConfig(key, gymId, { host: 'smtp.example.test', port: 587, security: 'starttls', from: 'gym@example.test', username: 'gym', password: 'private' }) } : {}), ...overrides });
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
it('tells owners how long the site was down after a failed rollback, and when a release stops being retried', async () => {
  const f = await fixture(), send = f.build();
  await send(f.gymId, { ...attempt, attemptedAt: '2026-11-03T15:05:00Z', result: 'failed', reason: 'rollback_failed', failures: 2 });
  await send(f.gymId, { ...attempt, reason: 'rollback_failed', failures: 2, downAt: '2026-11-03T15:02:00Z' });
  expect(f.email.messages).toHaveLength(4);
  expect(f.email.messages[0]!.text).toContain('Version v1.2.4 failed twice, so automatic updates will wait for a newer patch release.');
  // The recovery's times read in the gym's timezone, like the attempt time below them.
  expect(f.email.messages[2]!.text).toContain('The update to v1.2.4 and its rollback failed, so the site was down from Nov 4, 2026, 2:02 AM until Nov 4, 2026, 3:30 AM, when the hourly check started v1.2.3 again.');
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
  // The other owner still receives the notice in the same call, and a replay skips the uncertain recipient.
  expect(f.email.messages).toHaveLength(3);
  await send(f.gymId, next);
  expect(f.email.messages).toHaveLength(3);
});
it('still notifies the other owner when the host command meets an uncertain send', async () => {
  const f = await fixture(), command = createAutoUpdateCommand({ env, clock, scope: db.forGym, resolveGymId: async () => f.gymId,
    restoring: async () => false, notify: f.build() });
  const io = { stdout: () => {}, stderr: () => {} };
  f.email.respondNext(new DeliveryError('unknown', 'Lost reply'));
  // Exit 0 means the host drops the notice, so the second owner must be reached in this one run.
  expect(await command.run(['notice', '--at', attempt.attemptedAt, '--result', 'rolled_back', '--reason', 'health_check_failed',
    '--from', 'v1.2.3', '--to', 'v1.2.4'], io)).toBe(0);
  expect(f.email.messages).toHaveLength(1);
});
it('sends through the host record command and deduplicates concurrent replays', async () => {
  const f = await fixture(), notify = f.build();
  const command = createAutoUpdateCommand({ env, clock, scope: db.forGym, resolveGymId: async () => f.gymId,
    restoring: async () => false, notify });
  const errors: string[] = [], io = { stdout: () => {}, stderr: (message: string) => { errors.push(message); } };
  const args = ['record', '--at', attempt.attemptedAt, '--result', 'rolled_back', '--reason', 'health_check_failed', '--from', 'v1.2.3', '--to', 'v1.2.4'];
  const results = await Promise.all([command.run(args, io), command.run(args, io)]);
  // Each invocation can reserve a different owner and see the other's in-flight send.
  // Exit 3 asks the host to replay; neither concurrent invocation has to return 0.
  expect(results.every(code => code === 0 || code === 3), errors.join('\n')).toBe(true);
  expect(errors.every(message => message === 'Another attempt is sending this email'), errors.join('\n')).toBe(true);
  const audits = () => db.forGym(f.gymId, tx => tx.select().from(auditEvents));
  // Both commands have finished; each audit kind must already be unique before a sequential replay.
  const concurrent = await audits();
  expect(concurrent.filter(row => row.action === autoUpdateAttemptAction)).toHaveLength(1);
  expect(concurrent.filter(row => row.action === autoUpdateChangeAction)).toHaveLength(1);
  expect(await command.run(args, io)).toBe(0);
  expect(f.email.messages).toHaveLength(2);
  expect(new Set(f.email.messages.map(message => message.to)).size).toBe(2);
  expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, autoUpdateAttemptAction)))).toHaveLength(1);
  expect((await audits()).filter(row => row.action === autoUpdateChangeAction)).toHaveLength(1);
});
it('serializes an interleaved replay with its own per-gym lock, without holding up the gym\'s other writes', async () => {
  const f = await fixture(), home = await factory('households', f.gymId);
  const holding = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
  let calls = 0;
  // The first record's transaction stays open after its replay read and its writes, until the test releases it.
  const hooked = ((gymId: string, fn: Parameters<typeof db.forGym>[1]) => db.forGym(gymId, async (tx) => {
    const first = calls++ === 0, result = await fn(tx);
    if (first) {
      // eslint-disable-next-line database/system-tables -- Identify the held transaction for the lock-wait probe.
      holding.resolve((await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid);
      await release.promise;
    }
    return result;
  })) as typeof db.forGym;
  const attempts = createAutoUpdateAttempts({ scope: hooked, clock });
  const first = attempts.record(f.gymId, attempt);
  let second: Promise<unknown> | undefined;
  try {
    const pid = await holding.promise;
    // Another write for the same gym checks its foreign key on the gym row; the record lock must not stand in its way.
    const inserted = await Promise.race([factory('members', f.gymId, { householdId: home.id }).then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 5_000))]);
    expect(inserted).toBe(true);
    let finished = false;
    second = attempts.record(f.gymId, attempt).finally(() => { finished = true; });
    let waiting = false;
    for (let tries = 0; tries < 5_000 && !waiting && !finished; tries++)
      // eslint-disable-next-line database/system-tables -- The lock-wait probe, from the system connection.
      waiting = (await db.system.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))`))[0]!.n > 0;
    // The replay waits for the held report instead of reading past its uncommitted audits.
    expect(waiting).toBe(true);
    expect(finished).toBe(false);
  } finally { release.resolve(); await first; await second; }
  const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
  expect(audits.filter(row => row.action === autoUpdateAttemptAction)).toHaveLength(1);
  expect(audits.filter(row => row.action === autoUpdateChangeAction)).toHaveLength(1);
});
it('stores a deferred failure and its recovery, then sends only the recovery notice with per-owner replay protection', async () => {
  const f = await fixture(), command = createAutoUpdateCommand({ env, clock, scope: db.forGym, resolveGymId: async () => f.gymId,
    restoring: async () => false, notify: f.build() });
  const io = { stdout: () => {}, stderr: () => {} };
  const failed = ['--at', '2026-11-03T15:05:00Z', '--result', 'failed', '--reason', 'rollback_failed', '--from', 'v1.2.3', '--to', 'v1.2.4'];
  const recovered = ['--at', attempt.attemptedAt, '--result', 'rolled_back', '--reason', 'rollback_failed', '--from', 'v1.2.3', '--to', 'v1.2.4', '--down-at', '2026-11-03T15:02:00Z'];
  expect(await command.run(['record', ...failed, '--notice', 'deferred'], io)).toBe(0);
  expect(await command.run(['record', ...recovered, '--notice', 'deferred'], io)).toBe(0);
  expect(f.email.messages).toHaveLength(0);
  expect(await command.run(['notice', ...recovered], io)).toBe(0);
  expect(await command.run(['notice', ...recovered], io)).toBe(0);
  expect(f.email.messages).toHaveLength(2);
  expect(f.email.messages.every(message => message.text.includes('the site was down'))).toBe(true);
});

async function notice(gymId: string, options: AutoUpdateNoticeOptions) {
  const errors: string[] = [];
  const command = createAutoUpdateCommand({ env, clock, resolveGymId: async () => gymId, restoring: async () => false,
    notify: createAutoUpdateNotices({ env, clock, scope: db.forGym, ...options }) });
  const status = await command.run(['notice', '--at', attempt.attemptedAt, '--result', 'rolled_back',
    '--reason', 'health_check_failed', '--from', 'v1.2.3', '--to', 'v1.2.4'],
  { stdout: () => {}, stderr: line => { errors.push(line); } });
  return { status, errors };
}
it.each([
  ['encryption key', { APP_ENCRYPTION_KEY: 'invalid' }, 'settings are invalid'],
  ['SMTP security', { SMTP_SECURITY: 'invalid' }, 'settings are invalid'],
  ['SMTP sender', { SMTP_FROM: '' }, 'Invalid email from'],
  ['SMTP port', { SMTP_PORT: '0' }, 'Invalid SMTP port'],
  ['SMTP credentials', { SMTP_USER: 'owner', SMTP_PASS: '' }, 'Incomplete SMTP credentials'],
  ['auth secret', { AUTH_SECRET: 'short' }, 'AUTH_SECRET must contain'],
  ['auth mode', { AUTH_PASSWORD_LOGIN: 'invalid' }, 'AUTH_PASSWORD_LOGIN must be auto, on or off'],
] satisfies [string, NodeJS.ProcessEnv, string][])('drops a notice with invalid %s from the real configuration path', async (_path, invalid, message) => {
  const f = await fixture(false);
  const result = await notice(f.gymId, { env: { ...env, SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'gym@example.test', ...invalid },
    // Auth failures use the real default owner resolver; other cases do not need its database connection.
    ...('AUTH_SECRET' in invalid || 'AUTH_PASSWORD_LOGIN' in invalid ? {} : { owners: async () => [] }) });
  expect(result.status).toBe(0);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(message);
});
it.each(['timezone', 'branding'] as const)('drops a notice when the stored %s cannot be read or rendered', async field => {
  const f = await fixture(true, field === 'timezone' ? { timezone: 'Invalid/Zone' } : { branding: { logoKey: 42 } });
  const result = await notice(f.gymId, { owners: async () => [], transport: () => f.email });
  expect(result.status).toBe(0);
  expect(result.errors).toHaveLength(1);
});
it('drops a notice when a custom transport cannot be constructed, even with a network error code', async () => {
  const f = await fixture();
  const result = await notice(f.gymId, { owners: async () => [], transport: () => {
    throw Object.assign(new Error('Custom transport is invalid'), { code: 'ECONNREFUSED' });
  } });
  expect(result).toEqual({ status: 0, errors: ['Custom transport is invalid'] });
});
it('drops an uncertain custom-transport send even when it has a network error code', async () => {
  const f = await fixture();
  f.email.respondNext(Object.assign(new Error('Connection lost after sending'), { code: 'ECONNRESET' }));
  const options = { owners: (id: string) => accounts.staffEmails(id, ['owner']), transport: () => f.email };
  expect((await notice(f.gymId, options)).status).toBe(0);
  expect(f.email.messages).toHaveLength(1);
  expect((await notice(f.gymId, options)).status).toBe(0);
  expect(f.email.messages).toHaveLength(1);
});
it.each([false, true])('uses the real unreadable SMTP fallback (install SMTP: %s) without queuing a retry', async fallback => {
  const f = await fixture(true, { smtpConfig: 'unreadable-ciphertext' });
  const result = await notice(f.gymId, { env: { ...env, ...(fallback ? { SMTP_HOST: 'install.example.test', SMTP_FROM: 'gym@example.test' } : {}) },
    owners: id => accounts.staffEmails(id, ['owner']), transport: () => f.email });
  expect(result).toEqual({ status: 0, errors: [] });
  expect(f.email.messages).toHaveLength(fallback ? 2 : 0);
});

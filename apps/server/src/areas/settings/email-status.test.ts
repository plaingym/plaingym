// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { auditEvents, gyms, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { DeliveryError } from '../../infra/email/index.js';
import { SmtpDeliveryError } from '../../infra/email/smtp.js';
import { createEmailStatusRecorder, emailStatusActions, readEmailSendFailure, type InstallSettingsOptions } from './email-status.js';
import { createSmtpResolver, encryptSmtpConfig, installSmtpFingerprint } from './smtp.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-11-21T09:00:00.000Z');
const settings = { port: 587, security: 'starttls', source: 'gym' } as const;
const failed = (cause: unknown) => ({ ok: false as const, error: new SmtpDeliveryError('not_accepted', 'SMTP failed', { cause }) });
const authentication = failed({ code: 'EAUTH', responseCode: 535, response: '535 5.7.8 Authentication failed for desk@gym.example' });
const tls = failed({ code: 'ETLS' });
const sent = { ok: true as const };
const recorder = createEmailStatusRecorder({ scope: database.forGym, clock });
const gymA = uuidv7(), gymB = uuidv7();

async function rows(gymId: string) {
  return database.forGym(gymId, (tx) => tx.select({ action: auditEvents.action, after: auditEvents.after, actorKind: auditEvents.actorKind,
    targetType: auditEvents.targetType, targetId: auditEvents.targetId }).from(auditEvents)
    .where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, [...emailStatusActions]))).orderBy(asc(auditEvents.occurredAt), asc(auditEvents.id)));
}
// The test clock runs before this process started, so install-source rows are read as of the epoch unless a test says otherwise.
const shown = (gymId: string, options: InstallSettingsOptions = { installSince: new Date(0) }) =>
  database.forGym(gymId, (tx) => readEmailSendFailure(tx, gymId, options));
async function record(gymId: string, outcome: Parameters<ReturnType<typeof recorder>>[0], source: 'gym' | 'install' = 'gym') {
  clock.advance(1000);
  await recorder(gymId, { ...settings, source })(outcome);
}
async function audit(gymId: string, action: string, after: Record<string, unknown> | null = null) {
  clock.advance(1000);
  await database.forGym(gymId, (tx) => writeAudit(tx, { gymId, actorKind: 'system', action, targetType: 'gym', targetId: gymId, after, occurredAt: clock.now() }));
}
async function newGym() {
  const gymId = uuidv7();
  await factory('gyms', gymId);
  return gymId;
}
beforeAll(async () => {
  await factory('gyms', gymA);
  await factory('gyms', gymB);
});

describe('the recorded email state', () => {
  it('records a failure once per change of class, with the class only', async () => {
    await record(gymA, authentication);
    expect(await rows(gymA)).toEqual([{ action: 'email.delivery_failed', after: { failure: 'authentication', source: 'gym' }, actorKind: 'system', targetType: 'gym', targetId: gymA }]);
    const at = clock.now().toISOString();
    expect(await shown(gymA)).toEqual({ failure: 'authentication', at, source: 'gym' });
    await record(gymA, authentication);
    expect(await rows(gymA)).toHaveLength(1);
    await record(gymA, tls);
    expect((await rows(gymA)).map((row) => row.after)).toEqual([{ failure: 'authentication', source: 'gym' }, { failure: 'tls', source: 'gym' }]);
    expect(await shown(gymA)).toMatchObject({ failure: 'tls' });
    expect(JSON.stringify(await rows(gymA))).not.toMatch(/5\.7\.8|desk@gym|Authentication failed/);
  });
  it('records a recovery only after a failure, once', async () => {
    await record(gymA, sent);
    expect((await rows(gymA)).map((row) => row.action)).toEqual(['email.delivery_failed', 'email.delivery_failed', 'email.delivery_recovered']);
    expect((await rows(gymA)).at(-1)?.after).toBeNull();
    expect(await shown(gymA)).toBeNull();
    await record(gymA, sent);
    expect(await rows(gymA)).toHaveLength(3);
    const fresh = await newGym();
    await record(fresh, sent);
    expect(await rows(fresh)).toEqual([]);
  });
  it('records nothing for a refused recipient or an unknown outcome, and never for another gym', async () => {
    const gymId = await newGym();
    await record(gymId, failed({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 }));
    await record(gymId, { ok: false, error: new DeliveryError('unknown', 'SMTP delivery outcome is unknown', { cause: { code: 'ECONNECTION' } }) });
    expect(await rows(gymId)).toEqual([]);
    await record(gymId, authentication);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
    expect(await shown(gymB)).toBeNull();
    expect(await rows(gymB)).toEqual([]);
  });
  it('leaves at most two rows and one shown failure when two failures are recorded at once', async () => {
    const gymId = await newGym();
    clock.advance(1000);
    await Promise.all([recorder(gymId, settings)(authentication), recorder(gymId, settings)(authentication)]);
    const written = await rows(gymId);
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(written.length).toBeLessThanOrEqual(2);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
  });
  it('stops showing a failure once the settings change, and shows a later failure again', async () => {
    const gymId = await newGym();
    await record(gymId, authentication);
    await audit(gymId, 'integrations.email_saved', { source: 'gym' });
    expect(await shown(gymId)).toBeNull();
    await record(gymId, authentication);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
    await audit(gymId, 'integrations.email_removed', { source: 'none' });
    expect(await shown(gymId)).toBeNull();
    await record(gymId, tls);
    // Another setup step, or skipping the email step (no settings saved), leaves it; saving at the email step clears it.
    await audit(gymId, 'setup.step_completed', { step: 3 });
    expect(await shown(gymId)).toMatchObject({ failure: 'tls' });
    await audit(gymId, 'setup.step_completed', { step: 5, test: 'not_sent' });
    expect(await shown(gymId)).toMatchObject({ failure: 'tls' });
    await audit(gymId, 'setup.step_completed', { step: 5, test: 'sent' });
    expect(await shown(gymId)).toBeNull();
  });
  it('never throws when its record fails, and logs only the error\'s name', async () => {
    const logs: string[] = [], previous = setLogSink((line) => logs.push(line));
    try {
      const broken = createEmailStatusRecorder({ scope: async () => { throw new Error('database down for desk@gym.example'); }, clock });
      await expect(broken(gymA, settings)(authentication)).resolves.toBeUndefined();
      await expect(broken(gymA, settings)(sent)).resolves.toBeUndefined();
    } finally { setLogSink(previous); }
    expect(logs.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      expect.objectContaining({ event: 'email.status_record_failed', error: 'Error' }), expect.objectContaining({ event: 'email.status_record_failed', error: 'Error' })]);
    expect(logs.join('\n')).not.toContain('desk@gym.example');
  });
  it('records the settings source, and lets an install-source failure from before the process start lapse', async () => {
    const gymId = await newGym();
    await record(gymId, authentication, 'install');
    expect((await rows(gymId)).map((row) => row.after)).toEqual([{ failure: 'authentication', source: 'install' }]);
    const at = clock.now();
    expect(await shown(gymId, { installSince: new Date(at.getTime() + 1) })).toBeNull();
    expect(await shown(gymId, { installSince: new Date(at.getTime() - 1) })).toEqual({ failure: 'authentication', at: at.toISOString(), source: 'install' });
    // A process started after that row no longer shows it, so it records the same failure again.
    const restarted = createEmailStatusRecorder({ scope: database.forGym, clock, installSince: new Date(at.getTime() + 1) });
    clock.advance(1000);
    await restarted(gymId, { ...settings, source: 'install' })(authentication);
    expect((await rows(gymId)).map((row) => row.after)).toEqual([{ failure: 'authentication', source: 'install' }, { failure: 'authentication', source: 'install' }]);
    expect(await shown(gymId, { installSince: new Date(at.getTime() + 1) })).toEqual({ failure: 'authentication', at: clock.now().toISOString(), source: 'install' });
    // The default is this process's start, which is after the test clock's rows.
    expect(await database.forGym(gymId, (tx) => readEmailSendFailure(tx, gymId))).toBeNull();
  });
  it('keeps a gym-source failure, and one recorded without a source, standing whatever the process start', async () => {
    const own = await newGym();
    await record(own, authentication, 'gym');
    const later = { installSince: new Date(clock.now().getTime() + 60_000) };
    expect(await shown(own, later)).toMatchObject({ failure: 'authentication' });
    const legacy = await newGym();
    await audit(legacy, 'email.delivery_failed', { failure: 'authentication' });
    expect(await shown(legacy, later)).toMatchObject({ failure: 'authentication' });
    expect(await database.forGym(legacy, (tx) => readEmailSendFailure(tx, legacy))).toMatchObject({ failure: 'authentication' });
    expect(await shown(legacy, later)).toMatchObject({ source: 'gym' });
  });
});

describe('an install-source failure with the install settings\' fingerprint', () => {
  const key = parseEncryptionKey('cd'.repeat(32));
  const env = { SMTP_HOST: 'smtp.fingerprint.example', SMTP_FROM: 'noreply@fingerprint.example', SMTP_USER: 'install', SMTP_PASS: 'fingerprint-secret' };
  const F = installSmtpFingerprint(key, env)!, G = installSmtpFingerprint(key, { ...env, SMTP_PASS: 'another-secret' })!;
  it('stands while the fingerprint matches, whatever the process start, and lapses once it differs', async () => {
    const gymId = await newGym();
    clock.advance(1000);
    await createEmailStatusRecorder({ scope: database.forGym, clock, installSettings: F })(gymId, { ...settings, source: 'install' })(authentication);
    const at = clock.now();
    expect((await rows(gymId)).map((row) => row.after)).toEqual([{ failure: 'authentication', source: 'install', settings: F }]);
    // A restart after the row, with the same settings.
    const restarted = { installSince: new Date(at.getTime() + 60_000) };
    expect(await shown(gymId, { ...restarted, installSettings: F })).toEqual({ failure: 'authentication', at: at.toISOString(), source: 'install' });
    expect(await shown(gymId, { ...restarted, installSettings: G })).toBeNull();
    expect(await shown(gymId, { installSince: new Date(0), installSettings: G })).toBeNull();
    expect(await shown(gymId, { ...restarted, installSettings: null })).toBeNull();
    // Read without the current fingerprint, the process-start rule decides.
    expect(await shown(gymId, restarted)).toBeNull();
    const json = JSON.stringify(await rows(gymId));
    expect(json).not.toContain('smtp.fingerprint.example');
    expect(json).not.toContain('fingerprint-secret');
  });
  it('is recorded once when two processes started at different times report it', async () => {
    const gymId = await newGym();
    const first = createEmailStatusRecorder({ scope: database.forGym, clock, installSince: new Date(0), installSettings: F });
    clock.advance(1000);
    await first(gymId, { ...settings, source: 'install' })(authentication);
    const second = createEmailStatusRecorder({ scope: database.forGym, clock, installSince: new Date(clock.now().getTime() + 1), installSettings: F });
    clock.advance(1000);
    await second(gymId, { ...settings, source: 'install' })(authentication);
    clock.advance(1000);
    await first(gymId, { ...settings, source: 'install' })(authentication);
    expect((await rows(gymId)).map((row) => row.action)).toEqual(['email.delivery_failed']);
    // Changed settings make it a new failure through them.
    const changed = createEmailStatusRecorder({ scope: database.forGym, clock, installSettings: G });
    clock.advance(1000);
    await changed(gymId, { ...settings, source: 'install' })(authentication);
    expect((await rows(gymId)).map((row) => row.after)).toEqual([
      { failure: 'authentication', source: 'install', settings: F }, { failure: 'authentication', source: 'install', settings: G }]);
  });
  it('still lapses on a settings save, and a gym-source row carries no fingerprint', async () => {
    const gymId = await newGym();
    const recorder = createEmailStatusRecorder({ scope: database.forGym, clock, installSettings: F });
    clock.advance(1000);
    await recorder(gymId, { ...settings, source: 'install' })(authentication);
    await audit(gymId, 'integrations.email_saved', { source: 'gym' });
    expect(await shown(gymId, { installSettings: F })).toBeNull();
    clock.advance(1000);
    await recorder(gymId, settings)(tls);
    expect((await rows(gymId)).at(-1)?.after).toEqual({ failure: 'tls', source: 'gym' });
    expect(await shown(gymId, { installSettings: G })).toMatchObject({ failure: 'tls', source: 'gym' });
  });
});

describe('the SMTP resolver\'s report', () => {
  const key = parseEncryptionKey('ab'.repeat(32));
  const env = { SMTP_HOST: 'smtp.install.example', SMTP_PORT: '2525', SMTP_FROM: 'noreply@install.example', SMTP_USER: 'install', SMTP_PASS: 'install-secret' };
  it('records under the gym it resolved, for the gym\'s own settings and for the install\'s', async () => {
    const own = uuidv7(), installed = await newGym();
    const ownSettings = { host: 'smtp.gym.example', port: 465, security: 'tls', from: 'desk@gym.example', username: 'gym', password: 'gym-secret' } as const;
    await factory('gyms', own, { smtpConfig: encryptSmtpConfig(key, own, ownSettings) });
    const smtp = createSmtpResolver({ key, env, scope: database.forGym, clock });
    const ownConfig = await smtp.config(own), installConfig = await smtp.config(installed);
    expect(ownConfig).toMatchObject({ host: 'smtp.gym.example', report: expect.any(Function) });
    expect(installConfig).toMatchObject({ host: 'smtp.install.example', report: expect.any(Function) });
    clock.advance(1000);
    await ownConfig!.report!(authentication);
    expect(await shown(own)).toMatchObject({ failure: 'authentication' });
    expect(await shown(installed)).toBeNull();
    clock.advance(1000);
    await installConfig!.report!(tls);
    expect(await shown(installed)).toMatchObject({ failure: 'tls' });
    expect(await shown(own)).toMatchObject({ failure: 'authentication' });
    expect((await rows(own)).map((row) => row.after)).toEqual([{ failure: 'authentication', source: 'gym' }]);
    expect((await rows(installed)).map((row) => row.after)).toEqual([{ failure: 'tls', source: 'install', settings: installSmtpFingerprint(key, env) }]);
  });
  it('skips recording when email settings changed after config() resolved', async () => {
    const gymId = await newGym();
    const smtp = createSmtpResolver({ key, env, scope: database.forGym, clock });
    const staleConfig = await smtp.config(gymId);
    await audit(gymId, 'integrations.email_saved', { source: 'gym' });
    clock.advance(1000);
    await staleConfig!.report!(authentication);
    expect(await rows(gymId)).toEqual([]);
    expect(await shown(gymId)).toBeNull();

    const freshConfig = await smtp.config(gymId);
    clock.advance(1000);
    await freshConfig!.report!(authentication);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
    expect(await rows(gymId)).toHaveLength(1);

    clock.advance(1000);
    await staleConfig!.report!(sent);
    expect(await rows(gymId)).toHaveLength(1);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
  });
  it('still records when only another setup step or a skipped email step happened after config() resolved', async () => {
    const gymA2 = await newGym();
    const smtp = createSmtpResolver({ key, env, scope: database.forGym, clock });
    const skippedConfig = await smtp.config(gymA2);
    await audit(gymA2, 'setup.step_completed', { step: 5, test: 'not_sent' });
    clock.advance(1000);
    await skippedConfig!.report!(authentication);
    expect(await shown(gymA2)).toMatchObject({ failure: 'authentication' });

    const gymA3 = await newGym();
    const otherStepConfig = await smtp.config(gymA3);
    await audit(gymA3, 'setup.step_completed', { step: 3 });
    clock.advance(1000);
    await otherStepConfig!.report!(authentication);
    expect(await shown(gymA3)).toMatchObject({ failure: 'authentication' });
  });
  it('records a failure when no settings audit exists at all', async () => {
    const gymId = await newGym();
    const smtp = createSmtpResolver({ key, env, scope: database.forGym, clock });
    const installConfig = await smtp.config(gymId);
    clock.advance(1000);
    await installConfig!.report!(authentication);
    expect(await shown(gymId)).toMatchObject({ failure: 'authentication' });
  });
  it('waits for a settings save in progress and then records nothing', async () => {
    const gymId = await newGym();
    const smtp = createSmtpResolver({ key, env, scope: database.forGym, clock });
    const staleConfig = await smtp.config(gymId);
    let locked!: () => void, release!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    // A save locks the gym row and writes its audit row in one transaction, as Settings → Email does.
    const save = database.forGym(gymId, async (tx) => {
      await tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.id, gymId)).for('update');
      locked();
      await released;
      clock.advance(1000);
      await writeAudit(tx, { gymId, actorKind: 'system', action: 'integrations.email_saved', targetType: 'gym', targetId: gymId,
        after: { source: 'gym' }, occurredAt: clock.now() });
    });
    await lockHeld;
    const report = staleConfig!.report!(authentication);
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([save, report]);
    expect(await rows(gymId)).toEqual([]);
    expect(await shown(gymId)).toBeNull();
  });
});

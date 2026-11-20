// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- SQL only reads a transaction-local timeout setting.
import { sql } from 'drizzle-orm';
import { auditEvents, databaseCode, households, members, smsDailyUsage, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- One extra app-role connection holds the lock in this disposable test database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { setLogSink } from '../../core/log.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import type { SmsResolver } from '../../areas/settings/sms.js';
import { createSmsDeliveries, FakeSms, MemberSms, SmsDeliveryError, type MemberSmsOptions } from './index.js';
import { smsInFlightMs } from './deliveries.js';
import { smsDeadlineMs } from './constants.js';

const db = useTestDatabase(), make = createFactories(db), scope = db.forGym;
const phone = '+12025550123', message = { to: phone, body: 'Private notice' };
async function fixture(options: { enabled?: boolean; cap?: number } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T02:00:00Z');
  await make('gyms', gymId, { name: 'Test Gym', address: { country: 'US' }, timezone: 'America/Los_Angeles', memberSmsEnabled: options.enabled ?? true, smsDailyCap: options.cap ?? 1000 });
  const consent = { phone, phoneE164: phone, smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' };
  const home = await make('households', gymId, consent), person = await make('members', gymId, { ...consent, householdId: home.id });
  const sms = new FakeSms(), logSuppression = vi.fn();
  const resolver: SmsResolver = { async resolve(id) { return { gymId: id, name: 'Test Gym', sms }; }, async configured() { return true; }, async status() { return { source: 'gym', unreadable: false }; } };
  const settings = createGymSettingsAccessor({ scope });
  const sender = (changes: Partial<MemberSmsOptions> = {}) => new MemberSms({ gymId, memberIds: [person.id], householdIds: [], kind: 'notices', resolver, settings, scope, clock, logSuppression, ...changes });
  const usage = () => scope(gymId, tx => tx.select().from(smsDailyUsage));
  return { gymId, clock, consent, home, person, sms, resolver, settings, sender, usage, logSuppression };
}
it('sends only after its transactions commit, with the gym name and a local-day slot', async () => {
  const f = await fixture();
  expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
  expect(f.sms.messages).toEqual([{ ...message, body: 'Test Gym: ' + message.body }]);
  expect(await f.usage()).toEqual([expect.objectContaining({ day: '2026-11-15', sent: 1, refused: 0 })]);
});
it('refuses a body too long once the gym name is added, before taking a cap slot', async () => {
  const f = await fixture();
  await expect(f.sender().sendSms({ to: phone, body: 'x'.repeat(1600) })).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.sms.messages).toEqual([]); expect(await f.usage()).toEqual([]);
});
it('suppresses disabled and unconfigured providers without taking a cap slot', async () => {
  const f = await fixture({ enabled: false });
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'disabled' });
  const on = await fixture();
  expect(await on.sender({ resolver: { ...on.resolver, async resolve() { return null; } } }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_provider' });
  expect(f.sms.messages).toEqual([]); expect(on.sms.messages).toEqual([]); expect(await on.usage()).toEqual([]);
  expect(f.logSuppression).toHaveBeenCalledWith({ event: 'sms.suppressed', gymId: f.gymId, memberIds: [f.person.id], reason: 'disabled' });
});
it('requires the right consent and refuses empty, missing and anonymized recipients', async () => {
  const f = await fixture();
  for (const changes of [{ kind: 'announcements' as const }, { memberIds: [] }, { memberIds: [uuidv7()] }])
    expect(await f.sender(changes).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await scope(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.person.id)));
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(f.sms.messages).toEqual([]);
});
it('allows announcements only with announcements consent', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.update(members).set({ smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'portal' }).where(eq(members.id, f.person.id)));
  expect(await f.sender({ kind: 'announcements' }).sendSms(message)).toMatchObject({ status: 'sent' });
});
it.each(['member', 'household'] as const)('refuses a changed %s phone even when stored consent remains', async kind => {
  const f = await fixture();
  if (kind === 'member') await scope(f.gymId, tx => tx.update(members).set({ phone: '+12025550125' }).where(eq(members.id, f.person.id)));
  else await scope(f.gymId, tx => tx.update(households).set({ phone: '+12025550125' }).where(eq(households.id, f.home.id)));
  expect(await f.sender(kind === 'household' ? { householdIds: [f.home.id] } : {}).sendSms(message)).toEqual({ status: 'suppressed', reason: 'phone_changed' });
  expect(f.sms.messages).toEqual([]);
});
it('requires the billing phone consent independently and never uses it for announcements', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.update(members).set({ phone: null, phoneE164: null, smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, f.person.id)));
  expect(await f.sender({ householdIds: [f.home.id] }).sendSms(message)).toMatchObject({ status: 'sent' });
  expect(await f.sender({ householdIds: [f.home.id], kind: 'announcements' }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await scope(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
  expect(await f.sender({ householdIds: [f.home.id] }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(f.sms.messages).toHaveLength(1);
});
it('serializes concurrent cap reservations and counts every refused attempt', async () => {
  const f = await fixture({ cap: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.sender().sendSms(message)));
  expect(results.filter(result => result.status === 'sent')).toHaveLength(2);
  expect(results.filter(result => result.status === 'suppressed')).toEqual(Array(4).fill({ status: 'suppressed', reason: 'cap_reached' }));
  expect(await f.usage()).toEqual([expect.objectContaining({ sent: 2, refused: 4 })]);
  f.clock.advance(24 * 60 * 60_000);
  expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
  expect(await f.usage()).toHaveLength(2);
});
it('retries a persisted notice held on the usage lock beyond its in-flight window without losing or duplicating it', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-15', createdAt: f.clock.now() }));
  let unlock!: () => void, locked!: () => void, checking!: () => void, finished!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; }), lockTaken = new Promise<void>(resolve => { locked = resolve; });
  const checksStarted = new Promise<void>(resolve => { checking = resolve; }), checksFinished = new Promise<void>(resolve => { finished = resolve; });
  // The test database's two-connection pool remains free for preparation and recording its timeout.
  const holderConnection = openConnection(db.appUrl, 1);
  const holder = scopedDatabase(holderConnection.db).forGym(f.gymId, async tx => {
    await tx.select().from(smsDailyUsage).for('update'); locked(); await gate;
  });
  await lockTaken;
  const deliveries = createSmsDeliveries({ scope, clock: f.clock }), key = 'slow-lock:' + uuidv7();
  const waitingScope: typeof scope = (gymId, fn) => scope(gymId, tx => { checking(); return fn(tx); }).finally(finished);
  const reservation = await scope(f.gymId, tx => deliveries.reserve(tx, f.gymId, key));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const outcome = deliveries.attempt(reservation!, f.sender({ scope: waitingScope }), message).catch(error => error as Error);
    await checksStarted;
    await vi.advanceTimersByTimeAsync(smsDeadlineMs / 2);
    expect(await outcome).toMatchObject({ acceptance: 'not_accepted', message: 'SMS delivery failed' });
    f.clock.advance(smsInFlightMs + 1);
    expect(await deliveries.state(f.gymId, key)).toBe('not_accepted');
    expect(f.sms.messages).toEqual([]);
  } finally {
    vi.useRealTimers(); unlock(); await holder; await checksFinished; await holderConnection.close();
  }
  expect(await f.usage()).toEqual([expect.objectContaining({ sent: 0 })]);
  const retry = await scope(f.gymId, tx => deliveries.reserve(tx, f.gymId, key));
  expect(retry).toMatchObject({ attempts: 2 });
  await deliveries.attempt(retry!, f.sender(), message);
  expect(await scope(f.gymId, tx => deliveries.reserve(tx, f.gymId, key))).toBeUndefined();
  expect(f.sms.messages).toHaveLength(1);
  expect(await f.usage()).toEqual([expect.objectContaining({ sent: 1 })]);
});
it('rolls back a blocked preparation and frees its connection while the usage lock is still held', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-15', createdAt: f.clock.now() }));
  const locked = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>();
  const holderConnection = openConnection(db.appUrl, 1), senderConnection = openConnection(db.appUrl, 1);
  const senderScope = scopedDatabase(senderConnection.db).forGym;
  let lockHeld = false;
  const holder = scopedDatabase(holderConnection.db).forGym(f.gymId, async tx => {
    await tx.select().from(smsDailyUsage).for('update');
    lockHeld = true;
    locked.resolve();
    await unlock.promise;
    lockHeld = false;
  });
  // A regression must fail the assertion and clean up the connections while the test still has time left.
  const release = setTimeout(unlock.resolve, smsDeadlineMs / 2 + 7_000);
  try {
    await Promise.race([locked.promise, holder]);
    const rolledBack = Promise.withResolvers<unknown>();
    const waitingScope: typeof scope = (gymId, fn) => senderScope(gymId, fn).catch((error: unknown) => {
      rolledBack.resolve(error);
      throw error;
    });
    await expect(f.sender({ scope: waitingScope }).sendSms(message)).rejects.toMatchObject({
      acceptance: 'not_accepted', message: 'SMS recipient checks timed out',
    });
    const usage = await senderScope(f.gymId, tx => tx.select().from(smsDailyUsage));
    expect(lockHeld).toBe(true);
    expect(['55P03', '57014']).toContain(databaseCode(await rolledBack.promise));
    expect(usage).toEqual([expect.objectContaining({ sent: 0, refused: 0 })]);
    expect(f.sms.messages).toEqual([]);
  } finally {
    clearTimeout(release);
    unlock.resolve();
    try { await holder; } finally { await Promise.all([holderConnection.close(), senderConnection.close()]); }
  }
});
it.each(['sent', 'refused'] as const)('reverses a late %s increment on the original local day before rejecting', async counter => {
  const f = await fixture({ cap: 2 });
  const sent = counter === 'sent' ? 1 : 2, refused = 3, originalTime = f.clock.now();
  const day = '2026-11-15', nextDay = '2026-11-16';
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values([
    { gymId: f.gymId, day, sent, refused, createdAt: originalTime },
    { gymId: f.gymId, day: nextDay, sent: 2, refused: 1, createdAt: originalTime },
  ]));
  const usageWritten = Promise.withResolvers<{ sent: number; refused: number } | undefined>();
  const commitUsage = Promise.withResolvers<void>();
  const correctionWritten = Promise.withResolvers<void>(), commitCorrection = Promise.withResolvers<void>();
  let usageTransaction: Promise<unknown> | undefined, correctionTransaction: Promise<unknown> | undefined;
  const gatedScope: typeof scope = (gymId, fn) => {
    if (!usageTransaction) {
      // The real usage write holds the row lock while its commit is delayed past the deadline.
      const transaction = scope(gymId, async tx => {
        const result = await fn(tx);
        const [row] = await tx.select({ sent: smsDailyUsage.sent, refused: smsDailyUsage.refused })
          .from(smsDailyUsage).where(eq(smsDailyUsage.day, day));
        usageWritten.resolve(row);
        await commitUsage.promise;
        return result;
      });
      usageTransaction = transaction;
      return transaction;
    }
    const transaction = scope(gymId, async tx => {
      const result = await fn(tx);
      correctionWritten.resolve();
      await commitCorrection.promise;
      return result;
    });
    correctionTransaction = transaction;
    return transaction;
  };

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const outcome = f.sender({ scope: gatedScope }).sendSms(message).catch((error: unknown) => error)
    .finally(() => { settled = true; });
  try {
    expect(await Promise.race([usageWritten.promise, outcome])).toEqual({ sent, refused, [counter]: (counter === 'sent' ? sent : refused) + 1 });
    await vi.advanceTimersByTimeAsync(smsDeadlineMs / 2);
    expect(settled).toBe(false);
    f.clock.advance(24 * 60 * 60_000);
    vi.useRealTimers();
    commitUsage.resolve();
    expect(await Promise.race([correctionWritten.promise, outcome])).toBeUndefined();
    expect(settled).toBe(false);
    commitCorrection.resolve();
    expect(await outcome).toMatchObject({ acceptance: 'not_accepted', message: 'SMS recipient checks timed out' });
    f.clock.set(originalTime);
    if (counter === 'sent') {
      expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
      expect(f.sms.messages).toHaveLength(1);
    } else {
      expect(f.sms.messages).toEqual([]);
    }
    expect(await f.usage()).toEqual(expect.arrayContaining([
      expect.objectContaining({ day, sent: 2, refused }),
      expect.objectContaining({ day: nextDay, sent: 2, refused: 1 }),
    ]));
    expect(f.logSuppression).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    commitUsage.resolve();
    commitCorrection.resolve();
    await outcome;
    await Promise.allSettled([usageTransaction, correctionTransaction]);
  }
});

async function rejectAfterLateUsage(f: Awaited<ReturnType<typeof fixture>>, correct: typeof scope, lateMs = 0) {
  const usageWritten = Promise.withResolvers<void>(), commitUsage = Promise.withResolvers<void>();
  let preparing = true;
  const gatedScope: typeof scope = (gymId, fn) => {
    if (!preparing) return correct(gymId, fn);
    preparing = false;
    return scope(gymId, async tx => {
      const result = await fn(tx);
      usageWritten.resolve();
      await commitUsage.promise;
      return result;
    });
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const outcome = f.sender({ scope: gatedScope }).sendSms(message).catch((error: unknown) => error);
  try {
    expect(await Promise.race([usageWritten.promise, outcome])).toBeUndefined();
    await vi.advanceTimersByTimeAsync(smsDeadlineMs / 2);
    if (lateMs) await vi.advanceTimersByTimeAsync(lateMs);
    commitUsage.resolve();
    expect(await outcome).toMatchObject({ acceptance: 'not_accepted', message: 'SMS recipient checks timed out' });
    expect(f.sms.messages).toEqual([]);
  } finally {
    commitUsage.resolve();
    vi.useRealTimers();
  }
}

it.each([
  { cap: 2, exhaust: false, description: 'retries after the usage row lock clears within the correction wait' },
  { cap: 1, exhaust: true, description: 'logs one failure when the usage row stays locked through the correction wait' },
])('$description', async ({ cap, exhaust }) => {
  const f = await fixture({ cap });
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-15', sent: 1, createdAt: f.clock.now() }));
  const locked = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>();
  const log = vi.fn(), previousSink = setLogSink(log);
  const failures: (string | undefined)[] = [];
  let attempts = 0, holder: Promise<void> | undefined;
  const correct: typeof scope = async (gymId, fn) => {
    attempts++;
    if (!holder) {
      // Preparation has committed. Use the other pool connection to block the correction itself.
      holder = scope(gymId, async tx => {
        await tx.select().from(smsDailyUsage).for('update');
        locked.resolve();
        await unlock.promise;
      });
      await Promise.race([locked.promise, holder]);
    }
    try {
      return await scope(gymId, fn);
    } catch (error) {
      failures.push(databaseCode(error));
      if (!exhaust) {
        unlock.resolve();
        await holder;
      } else if (attempts === 1) {
        // Keep the real lock held through the first timeout, then leave one second of application time.
        await vi.advanceTimersByTimeAsync(smsDeadlineMs - 1_000);
      } else if (attempts === 2) {
        vi.advanceTimersByTime(1_000);
      }
      throw error;
    }
  };
  try {
    await rejectAfterLateUsage(f, correct);
    if (exhaust) {
      await vi.waitFor(() => expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"event":"sms.usage_correction_failed"')));
    } else {
      expect(log).not.toHaveBeenCalled();
    }
    expect(attempts).toBe(2);
    expect(failures).toHaveLength(exhaust ? 2 : 1);
    for (const code of failures) expect(['55P03', '57014']).toContain(code);
    expect(await f.usage()).toEqual([expect.objectContaining({ sent: 1, refused: exhaust ? 1 : 0 })]);
    if (!exhaust) {
      expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
      expect(f.sms.messages).toHaveLength(1);
      expect(await f.usage()).toEqual([expect.objectContaining({ sent: 2, refused: 0 })]);
    }
  } finally {
    setLogSink(previousSink);
    unlock.resolve();
    await holder;
  }
});

it('gives a correction committed near the end of the wait its full timeouts', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-15', sent: 1, createdAt: f.clock.now() }));
  const timeouts: string[] = [];
  const correct: typeof scope = (gymId, fn) => scope(gymId, async tx => {
    const result = await fn(tx);
    // eslint-disable-next-line database/system-tables -- Reads the correction's transaction-local timeout; no table access.
    timeouts.push((await tx.execute<{ timeout: string }>(sql`select current_setting('lock_timeout') as timeout`))[0]!.timeout);
    return result;
  });
  // Preparation commits with five milliseconds of the correction wait left.
  await rejectAfterLateUsage(f, correct, smsDeadlineMs - 5);
  expect(timeouts).toEqual(['3s']);
  expect(await f.usage()).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
});

it('attempts a late usage correction only once when its commit outcome is uncertain', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.insert(smsDailyUsage).values({ gymId: f.gymId, day: '2026-11-15', sent: 1, createdAt: f.clock.now() }));
  const log = vi.fn(), previousSink = setLogSink(log);
  let attempts = 0;
  const correct: typeof scope = async (gymId, fn) => {
    attempts++;
    await scope(gymId, fn);
    // PostgreSQL committed the decrement, but the caller received no acknowledgement.
    throw Object.assign(new Error('connection lost'), { code: '08006' });
  };
  try {
    await rejectAfterLateUsage(f, correct);
    expect(attempts).toBe(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('"event":"sms.usage_correction_failed"'));
    expect(await f.usage()).toEqual([expect.objectContaining({ sent: 1, refused: 0 })]);
  } finally {
    setLogSink(previousSink);
  }
});

it('clears every consent at an opted-out number in this gym, auditing identifiers only', async () => {
  const f = await fixture(), other = await fixture();
  const second = await make('members', f.gymId, { ...f.consent, smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'join' });
  const secondHome = await make('households', f.gymId, f.consent);
  f.sms.respondNext(new SmsDeliveryError('not_accepted', 'recipient_opted_out'));
  const deliveries = createSmsDeliveries({ scope, clock: f.clock }), key = 'notice:' + uuidv7();
  await expect(deliveries.send(f.gymId, key, f.sender(), message)).rejects.toMatchObject({ acceptance: 'not_accepted', reason: 'recipient_opted_out' });
  expect(await deliveries.state(f.gymId, key)).toBe('not_accepted');
  const rows = await scope(f.gymId, async tx => ({ people: await tx.select().from(members), homes: await tx.select().from(households), audits: await tx.select().from(auditEvents) }));
  for (const person of rows.people) expect(person).toMatchObject({ smsNoticesConsentAt: null, smsNoticesConsentSource: null, smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null });
  for (const home of rows.homes.filter(home => [f.home.id, secondHome.id].includes(home.id))) expect(home).toMatchObject({ smsNoticesConsentAt: null, smsNoticesConsentSource: null });
  expect(rows.audits.map(row => row.targetId)).toEqual(expect.arrayContaining([f.person.id, second.id, f.home.id, secondHome.id]));
  expect(rows.audits.every(row => JSON.stringify(row.after) === '{"source":"provider"}')).toBe(true);
  expect(JSON.stringify(rows.audits)).not.toContain(phone); expect(JSON.stringify(rows.audits)).not.toContain(message.body);
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(await other.sender().sendSms(message)).toMatchObject({ status: 'sent' });
});
it('refuses a foreign member, household, provider or settings projection', async () => {
  const f = await fixture(), other = await fixture();
  for (const changes of [{ memberIds: [other.person.id] }, { householdIds: [other.home.id] }])
    expect(await f.sender(changes).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await expect(f.sender({ resolver: { ...other.resolver, async resolve() { return { gymId: other.gymId, name: 'Other', sms: other.sms }; } } }).sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  await expect(f.sender({ settings: { get: () => other.settings.get(other.gymId) } }).sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.sms.messages).toEqual([]); expect(other.sms.messages).toEqual([]);
});

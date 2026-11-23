// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { intakeRateLimits, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createIntakeRateLimitStore } from './rate-limit-store.js';
import { AppError } from '@plaingym/shared';
import { cacheRefusals, type IntakeReservationResult, type SharedRateLimitStore } from './rate-limit.js';
import { createPublicIntakeCeiling, publicIntakeLimits } from './rate-limit-intake.js';
import { setLogSink } from './log.js';

const db = useTestDatabase(), factory = createFactories(db);
const GiB = 1024 ** 3;
it('requires every shared store to reserve, every refusal to name its bucket, and counts each consume as one', () => {
  // @ts-expect-error A shared store without reserve would refuse every public admission.
  const consumeOnly: SharedRateLimitStore = { async consume() { return { allowed: true, resetAt: 0 }; } };
  // @ts-expect-error A refusal names its bucket unless the store failed.
  const unnamed: IntakeReservationResult = { allowed: false, resetAt: 1 };
  const store = createIntakeRateLimitStore(db.forSystem);
  // @ts-expect-error consume has no weighted amount.
  const weighted = () => store.consume({ gymId: null, routeKey: 'r', clientKey: 'c', now: 0, windowMs: 1000, limit: 10, amount: 2 });
  expect([consumeOnly, unnamed, weighted].every(Boolean)).toBe(true);
});

it('reports a refusal naming no bucket of the reservation against the first one, once per window', async () => {
  const now = 10_000, gymId = uuidv7(), input = { gymId, timezone: 'UTC', now, participants: 1, signatureBytes: 0 };
  const store: SharedRateLimitStore = {
    async consume() { return { allowed: true, resetAt: 0 }; },
    async reserve() { return { allowed: false, resetAt: now + 5000, routeKey: 'unknown.bucket' }; },
  };
  const reserve = createPublicIntakeCeiling({ store });
  const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
  try {
    for (let i = 0; i < 2; i++) {
      const refused = await reserve(input).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(AppError);
      expect(refused).toMatchObject({ code: 'rate_limited', details: { reason: ['intake_ceiling'], resetAt: [String(now + 5000)] } });
    }
    expect(lines.map(line => JSON.parse(line))).toMatchObject([{ event: 'public.intake.ceiling_reached', gymId, resource: 'participants' }]);
    expect(lines).toHaveLength(1);
  } finally { setLogSink(previous); }
});
it.each(['database', 'local'] as const)('refuses just past the 1 GiB hourly ceiling without spending participants (%s)', async kind => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const reserve = createPublicIntakeCeiling({ ...(kind === 'database' ? { store: createIntakeRateLimitStore(db.forSystem) } : {}), participants: 2 });
  const input = { gymId, timezone: 'UTC', now: 0, participants: 1, signatureBytes: GiB };
  await reserve(input);
  await expect(reserve({ ...input, signatureBytes: 1 })).rejects.toMatchObject({ details: { reason: ['intake_ceiling'], resetAt: ['3600000'] } });
  // The byte refusal did not spend the last participant, which a trial can still use.
  await expect(reserve({ ...input, signatureBytes: 0 })).resolves.toBeUndefined();
  await expect(reserve({ ...input, signatureBytes: 0 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(reserve({ ...input, now: publicIntakeLimits.windowMs })).resolves.toBeUndefined();
});

it.each([
  ['America/New_York', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'], // 25-hour local day.
  ['America/New_York', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'], // 23-hour local day.
  ['Asia/Kolkata', '2026-11-01T18:30:00Z', '2026-11-02T18:30:00Z'],
])('refuses just past 4 GiB and resets at local midnight in %s (%s)', async (timezone, start, end) => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const first = createPublicIntakeCeiling({ store: cacheRefusals(createIntakeRateLimitStore(db.forSystem)) });
  const second = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem) });
  const input = { gymId, timezone, now: new Date(start).getTime(), participants: 1, signatureBytes: GiB };
  for (let hour = 0; hour < 4; hour++) await first({ ...input, now: input.now + hour * publicIntakeLimits.windowMs });
  const now = input.now + 4 * publicIntakeLimits.windowMs;
  await expect(second({ ...input, now, signatureBytes: 1 })).rejects.toMatchObject({
    code: 'rate_limited', details: { resetAt: [String(new Date(end).getTime())] },
  });
  await expect(second({ ...input, now: new Date(end).getTime() - 1, signatureBytes: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(second({ ...input, now: new Date(end).getTime() })).resolves.toBeUndefined();
});

it('resets the local daily fallback at midnight without resetting the containing UTC hour', async () => {
  const reserve = createPublicIntakeCeiling({ signatureKiB: 4, dailySignatureKiB: 2 });
  const midnight = new Date('2026-11-02T18:30:00Z').getTime();
  const input = { gymId: uuidv7(), timezone: 'Asia/Kolkata', now: midnight - 1, participants: 1, signatureBytes: 2048 };
  await reserve(input);
  await expect(reserve({ ...input, signatureBytes: 1 })).rejects.toMatchObject({ details: { resetAt: [String(midnight)] } });
  await expect(reserve({ ...input, now: midnight })).resolves.toBeUndefined();
  // Both admissions fall in the same UTC hour: its independent byte allowance is now full.
  const endOfHour = new Date('2026-11-02T19:00:00Z').getTime();
  await expect(reserve({ ...input, now: midnight, signatureBytes: 1 })).rejects.toMatchObject({ details: { resetAt: [String(endOfHour)] } });
});

it('rolls back every earlier increment when either byte window or participants refuses', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const reserve = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), participants: 2, signatureKiB: 4, dailySignatureKiB: 4 });
  const input = { gymId, timezone: 'UTC', now: 0, participants: 1, signatureBytes: 1025 };
  await reserve(input);
  await expect(reserve({ ...input, signatureBytes: 2049 })).rejects.toMatchObject({ code: 'rate_limited' });
  await reserve(input);
  await expect(reserve({ ...input, signatureBytes: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
  const rows = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, gymId)));
  expect(Object.fromEntries(rows.map(row => [row.routeKey, row.count]))).toEqual({
    'public.intake.participants': 2, 'public.intake.signature_kib': 4, 'public.intake.signature_kib_day': 4,
  });
});

it('keeps concurrent hourly and daily byte reservations atomic across independent processes', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const stores = Array.from({ length: 2 }, () => createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), signatureKiB: 10, dailySignatureKiB: 15 }));
  const input = { gymId, timezone: 'UTC', now: 0, participants: 1, signatureBytes: 1 };
  for (const [hour, allowed] of [[0, 10], [1, 5]] as const) {
    const replies = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => stores[i % 2]!({ ...input, now: hour * publicIntakeLimits.windowMs })));
    expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(allowed);
  }
  const rows = await db.forSystem(tx => tx.select().from(intakeRateLimits).where(eq(intakeRateLimits.gymId, gymId)));
  expect(rows.filter(row => row.routeKey === 'public.intake.participants').map(row => row.count).sort((a, b) => a - b)).toEqual([5, 10]);
  expect(rows.find(row => row.routeKey === 'public.intake.signature_kib_day')!.count).toBe(15);
});

it('reports failed counters separately, logs once, and propagates a database outage', async () => {
  // An invalid gym makes the real counter INSERT fail its foreign key, while select 1 still works.
  const report = vi.fn(), store = createIntakeRateLimitStore(db.forSystem, report);
  const reserve = createPublicIntakeCeiling({ store });
  const input = { gymId: uuidv7(), timezone: 'UTC', now: 0, participants: 1, signatureBytes: 1 };
  await expect(reserve(input)).rejects.toMatchObject({ details: { reason: ['intake_store_failed'], resetAt: ['1000'] } });
  await expect(reserve(input)).rejects.toMatchObject({ details: { reason: ['intake_store_failed'] } });
  expect(report).toHaveBeenCalledTimes(1);
  const outage = new Error('database unavailable');
  const down = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(async () => { throw outage; }, report) });
  await expect(down(input)).rejects.toBe(outage);
});

it('atomically caps participants across processes, isolates gyms and resets the hour', async () => {
  const gymId = uuidv7(), otherGym = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const first = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), participants: 10 });
  const second = createPublicIntakeCeiling({ store: createIntakeRateLimitStore(db.forSystem), participants: 10 });
  const input = { gymId, timezone: 'UTC', now: 0, participants: 1, signatureBytes: 0 };
  const replies = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => (i % 2 ? first : second)(input)));
  expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(10);
  expect(replies.filter(r => r.status === 'rejected')).toHaveLength(14);
  await expect(first({ ...input, gymId: otherGym })).resolves.toBeUndefined();
  await expect(second({ ...input, now: publicIntakeLimits.windowMs - 1 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(second({ ...input, now: publicIntakeLimits.windowMs })).resolves.toBeUndefined();
});

it('counts decoded bytes rounded up to KiB and a refused large reservation leaves room for a smaller one', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const ceiling = () => createPublicIntakeCeiling({ store: cacheRefusals(createIntakeRateLimitStore(db.forSystem)), signatureKiB: 4 });
  const input = { gymId, timezone: 'UTC', now: 0, participants: 1, signatureBytes: 1025 };
  await ceiling()(input); // Two KiB.
  await expect(ceiling()({ ...input, signatureBytes: 2049 })).rejects.toMatchObject({ code: 'rate_limited' });
  await expect(ceiling()(input)).resolves.toBeUndefined(); // Exactly four KiB across independent stores.
  await expect(ceiling()({ ...input, signatureBytes: 1 })).rejects.toMatchObject({ code: 'rate_limited' });
});

it('does not cache a weighted refusal and logs the spent resource once per gym and hour', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const reserve = createPublicIntakeCeiling({ store: cacheRefusals(createIntakeRateLimitStore(db.forSystem)), participants: 3 });
  const input = { gymId, timezone: 'UTC', now: 0, participants: 2, signatureBytes: 0 };
  const lines: string[] = [], previous = setLogSink(line => { lines.push(line); });
  try {
    await reserve(input);
    await expect(reserve(input)).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(reserve({ ...input, participants: 1 })).resolves.toBeUndefined();
    await expect(reserve(input)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(lines.map(line => JSON.parse(line))).toMatchObject([{ event: 'public.intake.ceiling_reached', gymId, resource: 'participants', limit: 3 }]);
    await reserve({ ...input, now: publicIntakeLimits.windowMs });
    await expect(reserve({ ...input, now: publicIntakeLimits.windowMs })).rejects.toMatchObject({ code: 'rate_limited' });
    expect(lines).toHaveLength(2);
  } finally { setLogSink(previous); }
});

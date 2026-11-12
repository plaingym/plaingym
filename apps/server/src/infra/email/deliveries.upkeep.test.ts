// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { commandDigest, createEmailDeliveries, createEmailDeliveryJobs, createKeyedCommandDigest, emailDeliveryUpkeepJob, FakeEmail } from './index.js';
import { emailInFlightMs } from './deliveries.js';

const database = useTestDatabase(), factory = createFactories(database);
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-12T12:00:00Z');
  await factory('gyms', gymId);
  const deliveries = createEmailDeliveries({ scope: database.forGym, clock });
  const ago = (ms: number) => new Date(clock.now().getTime() - ms);
  const row = (key: string, values: { state?: string; age?: number; commandDigest?: string | null } = {}) => factory('emailDeliveries', gymId,
    { key, state: values.state ?? 'accepted', createdAt: ago(values.age ?? 0), updatedAt: ago(values.age ?? 0), commandDigest: values.commandDigest ?? null });
  const rows = () => database.forGym(gymId, tx => tx.select().from(emailDeliveries).where(eq(emailDeliveries.gymId, gymId)));
  return { gymId, clock, deliveries, row, rows };
}

describe('login link rows', () => {
  it('are deleted once the link has expired and no attempt can be in flight, and every other row stays', async () => {
    const f = await fixture(), old = emailInFlightMs + 1000;
    const expired = await f.row('auth.login_link:' + commandDigest(['https://gym.example.test/a']), { age: old });
    const unknown = await f.row('auth.login_link:' + commandDigest(['https://gym.example.test/b']), { age: old, state: 'sending' });
    const fresh = await f.row('auth.login_link:' + commandDigest(['https://gym.example.test/c']), { age: 5 * 60_000 + 1000 });
    const inFlight = await f.row('auth.login_link:' + commandDigest(['https://gym.example.test/d']), { age: 60_000, state: 'sending' });
    const lookalike = await f.row('auth.loginXlink:' + uuidv7(), { age: old });
    const other = await f.row('billing.alerts.send:' + uuidv7(), { age: 365 * 86_400_000 });
    const foreign = await fixture();
    const elsewhere = await foreign.row('auth.login_link:' + commandDigest(['https://other.example.test/a']), { age: old });
    expect(await f.deliveries.upkeep(f.gymId)).toMatchObject({ swept: 2 });
    expect((await f.rows()).map(row => row.id).sort()).toEqual([fresh.id, inFlight.id, lookalike.id, other.id].sort());
    expect((await foreign.rows()).map(row => row.id)).toEqual([elsewhere.id]);
    expect((await f.rows()).map(row => row.id)).not.toContain(expired.id);
    expect((await f.rows()).map(row => row.id)).not.toContain(unknown.id);
  });
  it('the hourly job runs the upkeep for its gym', async () => {
    const calls: string[] = [];
    const [job] = createEmailDeliveryJobs({ async upkeep(gymId) { calls.push(gymId); return { swept: 0 }; } });
    expect(job).toMatchObject({ id: emailDeliveryUpkeepJob, cron: expect.stringMatching(/ \* \* \* \*$/) });
    const gymId = uuidv7();
    await job!.handler({}, { gymId, jobId: uuidv7(), timezone: 'UTC', attempt: 1, clock: new TestClock('2026-11-12T12:00:00Z') });
    expect(calls).toEqual([gymId]);
  });
});

describe('portal invitation digests', () => {
  it('are keyed: a digest is fixed for the request but needs the secret to compute', () => {
    const keyed = createKeyedCommandDigest('a'.repeat(40)), request = ['payer@example.test', 'payer', null];
    expect(keyed(request)).toBe(keyed(request));
    expect(keyed(request)).toMatch(/^k1:[A-Za-z0-9_-]{43}$/);
    expect(keyed(request)).not.toBe(createKeyedCommandDigest('b'.repeat(40))(request));
    expect(keyed(request)).not.toContain(commandDigest(request));
  });

});

describe('attempt with a message builder', () => {
  it('releases the reservation when the builder throws, so nothing was sent and the command can run again', async () => {
    const f = await fixture(), key = 'test.command:' + uuidv7(), email = new FakeEmail(), digest = commandDigest(['request']);
    const reservation = await database.forGym(f.gymId, tx => f.deliveries.reserve(tx, f.gymId, key, digest));
    await expect(f.deliveries.attempt(reservation, email, () => { throw new Error('Render failed'); })).rejects.toThrow('Render failed');
    expect(email.messages).toEqual([]);
    expect(await f.deliveries.state(f.gymId, key)).toBe('not_accepted');
    const again = await database.forGym(f.gymId, tx => f.deliveries.reserve(tx, f.gymId, key, digest));
    await f.deliveries.attempt(again, email, async () => ({ to: 'payer@example.test', subject: 'Hi', text: 'Hi', html: '<p>Hi</p>' }));
    expect(email.messages).toHaveLength(1);
    expect(await f.deliveries.state(f.gymId, key)).toBe('accepted');
  });
});

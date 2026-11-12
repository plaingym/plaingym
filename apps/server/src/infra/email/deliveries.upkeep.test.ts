// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { commandDigest, createEmailDeliveries, createEmailDeliveryJobs, createKeyedCommandDigest, emailDeliveryUpkeepJob, FakeEmail,
  recipientDigest } from './index.js';
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
const hex = recipientDigest('payer@example.test');

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
    const [job] = createEmailDeliveryJobs({ async upkeep(gymId) { calls.push(gymId); return { swept: 0, cleared: 0, adopted: 0 }; } });
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
  it('an unkeyed digest from an earlier release is cleared once its attempt settled; keyed ones and other rows stay', async () => {
    const f = await fixture(), keyed = createKeyedCommandDigest('a'.repeat(40))(['payer@example.test', 'payer', null]);
    const legacy = commandDigest(['payer@example.test', 'payer', null]);
    const settled = await f.row(`portal.invitation:${uuidv7()}:${uuidv7()}`, { commandDigest: legacy });
    const stale = await f.row(`portal.invitation:${uuidv7()}:${uuidv7()}`, { commandDigest: legacy, state: 'sending', age: emailInFlightMs + 1000 });
    const inFlight = await f.row(`portal.invitation:${uuidv7()}:${uuidv7()}`, { commandDigest: legacy, state: 'sending' });
    const current = await f.row(`portal.invitation:${uuidv7()}:${uuidv7()}`, { commandDigest: keyed });
    const link = await f.row(`links.send.pay_invoice:${uuidv7()}:${uuidv7()}`, { commandDigest: commandDigest([uuidv7(), null, null]) });
    expect(await f.deliveries.upkeep(f.gymId)).toMatchObject({ cleared: 2 });
    const digests = new Map((await f.rows()).map(row => [row.id, row.commandDigest]));
    expect(digests.get(settled.id)).toBeNull();
    expect(digests.get(stale.id)).toBeNull();
    expect(digests.get(inFlight.id)).toBe(legacy);
    expect(digests.get(current.id)).toBe(keyed);
    expect(digests.get(link.id)).toBe(link.commandDigest);
  });
});

describe('member notice keys from an earlier release', () => {
  it('lose their recipient digest, keeping the row that decides the most; staff keys stay per recipient', async () => {
    const f = await fixture(), receipt = `billing.receipt:${uuidv7()}:${uuidv7()}`, dunning = `billing.dunning:${uuidv7()}:${uuidv7()}`;
    const refused = `billing.dunning:${uuidv7()}:${uuidv7()}`, staff = `billing.refund_failure:${uuidv7()}:${uuidv7()}:${hex}`;
    const sent = await f.row(`${receipt}:${hex}`);
    // The address changed between retries: one attempt was refused, the other accepted.
    await f.row(`${dunning}:${recipientDigest('old@example.test')}`, { state: 'not_accepted' });
    const accepted = await f.row(`${dunning}:${hex}`);
    const notSent = await f.row(`${refused}:${hex}`, { state: 'not_accepted' });
    const staffRow = await f.row(staff);
    expect(await f.deliveries.upkeep(f.gymId, 2)).toMatchObject({ adopted: 3 });
    const rows = await f.rows();
    expect(rows.map(row => [row.id, row.key, row.state]).sort()).toEqual([
      [sent.id, receipt, 'accepted'], [accepted.id, dunning, 'accepted'], [notSent.id, refused, 'not_accepted'], [staffRow.id, staff, 'accepted'],
    ].sort());
    expect(rows.filter(row => row.key.startsWith('billing.receipt:') || row.key.startsWith('billing.dunning:')).some(row => /[0-9a-f]{64}/.test(row.key))).toBe(false);
    expect(await f.deliveries.upkeep(f.gymId)).toMatchObject({ adopted: 0 });
  });
  it('a definite non-send under the new key gives way to an earlier row that was sent; otherwise the new key decides', async () => {
    const f = await fixture(), first = `billing.receipt:${uuidv7()}:${uuidv7()}`, second = `billing.receipt:${uuidv7()}:${uuidv7()}`;
    await f.row(first, { state: 'not_accepted' });
    const earlier = await f.row(`${first}:${hex}`, { state: 'unknown' });
    const decided = await f.row(second, { state: 'accepted' });
    await f.row(`${second}:${hex}`, { state: 'not_accepted' });
    await database.forGym(f.gymId, async tx => { await f.deliveries.adopt(tx, f.gymId, first); await f.deliveries.adopt(tx, f.gymId, second); });
    const rows = await f.rows();
    expect(rows.map(row => [row.id, row.key, row.state]).sort()).toEqual([[earlier.id, first, 'unknown'], [decided.id, second, 'accepted']].sort());
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

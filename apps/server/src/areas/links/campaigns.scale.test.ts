// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { asc, inArray } from 'drizzle-orm';
import { auditEvents, households, paymentMethods, signedLinks, uuidv7, type Transaction } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { isInTransaction } from '@plaingym/shared/transaction';
import { TestClock } from '../../core/clock.js';
import { FakeEmail } from '../../infra/email/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createCampaignsService, campaignPublishJob, campaignSendJob } from './campaigns.js';
import { createCampaignJobs } from './campaigns.jobs.js';
import type { SignedLinkDelivery } from './service.delivery.js';
import { campaignCreationLease } from './campaigns.customers.js';
import { creationLeaseMs, creationReleasedAction, creationRetriedAction, customerRequestHash, customerUnlinkedAction, reservationAction } from '../billing/customers.js';

// Seeding and publishing 2000 recipients takes seconds, so this test has a file of its own, apart from the campaign tests that share a fixture.
const db = useTestDatabase(), factory = createFactories(db);
const origin = 'https://gym.example.test';
const messages = JSON.parse(await readFile(new URL('../../../../../locales/en/links/service.json', import.meta.url), 'utf8')) as Record<string, string>;

it('creates 2000 recipients in chunked multi-row inserts with only one publish job, then publishes once with audit batches of 100', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId, { memberEmailsEnabled: true, billingEnabled: true, timezone: 'America/Los_Angeles' });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), provider = new FakePayments(gymId, clock);
  const paymentsFor = vi.fn(async () => { expect(isInTransaction()).toBe(false); return provider; });
  const delivery: SignedLinkDelivery = { prepare: vi.fn(async (id: string) => {
    expect(isInTransaction()).toBe(false);
    return { gymId: id, gymName: 'Test Gym', origin, email, memberEmailsEnabled: true,
      t: createTranslator({ 'links/service': messages }) };
  }) };
  const people = await db.forGym(gymId, tx => tx.insert(households).values(Array.from({ length: 2000 }, (_, i) => ({
    gymId, name: 'Household ' + i, email: `payer${i}@example.test`,
  }))).returning({ id: households.id }));
  let transactions = 0, inserts = 0;
  // Counts insert statements, so creation cannot fall back to a round trip per recipient.
  const counted = (tx: Transaction) => new Proxy(tx, { get(target, key) {
    if (key === 'insert') inserts++;
    const value = Reflect.get(target, key) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const service = createCampaignsService({ scope: async (id, fn) => { transactions++; return db.forGym(id, tx => fn(counted(tx))); },
    clock, jobs, delivery, paymentsFor });
  const enqueue = vi.spyOn(jobs, 'enqueue');
  const context = { gymId, actor: { kind: 'system' as const } };
  const c = await service.create(context, { name: 'Collect cards', purpose: 'update_card', expiresAt: '2026-11-26T12:00:00Z',
    reminderSchedule: [3, 7], recipients: people.map(p => ({ householdId: p.id })) });
  expect(enqueue).toHaveBeenCalledTimes(1); expect(jobs.jobs[0]!.name).toBe(campaignPublishJob);
  expect(transactions).toBe(3); // Definition, settings, and response; no recipient publication work.
  expect(inserts).toBe(10); // The campaign, four chunks of 500 links and their audits, and the campaign audit.
  transactions = 0;
  const publish = createCampaignJobs(() => service).find(j => j.id === campaignPublishJob)!;
  await publish.handler({ campaignId: c.campaign.id }, { gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  expect(transactions).toBe(23); // Settings, recipients, history, twenty audit batches.
  await service.publish({ campaignId: c.campaign.id }, gymId);
  const sends = jobs.jobs.filter(j => j.name === campaignSendJob);
  expect(sends).toHaveLength(2000); expect(new Set(sends.map(j => j.options.idempotencyKey)).size).toBe(2000);
  expect(email.messages).toHaveLength(0);
}, 90_000);

interface Read { sql: string; rows: number }
/** A scope that records each select it runs inside forGym, with the number of rows the database returned for it. */
function recording(reads: Read[]): typeof db.forGym {
  const watch = <T extends object>(builder: T): T => new Proxy(builder, { get(target, key, receiver) {
    const value = Reflect.get(target, key) as unknown;
    // Drizzle recognizes a builder (a subquery, say) by its constructor.
    if (typeof value !== 'function' || key === 'constructor') return value;
    if (key === 'then') return (resolve: (rows: unknown) => unknown, reject: (error: unknown) => unknown) => {
      const sql = (target as unknown as { toSQL(): { sql: string } }).toSQL().sql;
      return (target as unknown as PromiseLike<unknown>).then(rows => {
        reads.push({ sql, rows: Array.isArray(rows) ? rows.length : 1 });
        return resolve(rows);
      }, reject);
    };
    // Builder steps return the builder itself, or (from) the next builder: keep both watched.
    return (...args: unknown[]) => {
      const result = (value as (...a: unknown[]) => unknown).apply(target, args);
      return result === target ? receiver : typeof result === 'object' && result !== null && 'toSQL' in result ? watch(result) : result;
    };
  } });
  return (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key) as unknown;
    if ((key === 'select' || key === 'selectDistinctOn') && typeof value === 'function') return (...args: unknown[]) => watch((value as (...a: unknown[]) => object).apply(target, args));
    return typeof value === 'function' ? value.bind(target) : value;
  } })));
}

it('reads only four lease events in one statement across many customer generations', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z');
  await factory('gyms', gymId);
  const household = await factory('households', gymId);
  const events: (typeof auditEvents.$inferInsert)[] = [];
  let reservation = '', attempt = '';
  for (let generation = 0; generation < 20; generation++) {
    const unlinked = uuidv7(); reservation = uuidv7(); attempt = uuidv7();
    const add = (id: string, action: string, after: unknown) => {
      const time = new Date(clock.now().getTime() + events.length);
      events.push({ id, gymId, targetType: 'household', targetId: household.id, actorKind: 'system', action, after, createdAt: time, occurredAt: time });
    };
    add(unlinked, customerUnlinkedAction, null);
    add(reservation, reservationAction, { unlinked, requestHash: customerRequestHash(household, unlinked) });
    add(attempt, creationRetriedAction, { reservation });
    add(uuidv7(), creationReleasedAction, { reservation, attempt });
  }
  await db.forGym(gymId, tx => tx.insert(auditEvents).values(events));
  clock.advance(creationLeaseMs + events.length);
  const reads: Read[] = [];
  expect(await recording(reads)(gymId, tx => campaignCreationLease(tx, household, clock.now())))
    .toEqual({ state: 'released', reservation, attempt, matchesRequest: true });
  expect(reads).toHaveLength(1); expect(reads[0]!.rows).toBe(4);
});

it('serves a 320-household campaign with batched creation, grouped progress, SQL recipient pages and a Stripe-free card filter', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z'), size = 320;
  await factory('gyms', gymId, { memberEmailsEnabled: true, billingEnabled: true, timezone: 'America/Los_Angeles' });
  const people = await db.forGym(gymId, tx => tx.insert(households).values(Array.from({ length: size }, (_, i) => ({
    gymId, name: 'Household ' + i, email: `payer${i}@example.test` }))).returning({ id: households.id }));
  // Every third household has a saved card; one of those was removed.
  const carded = people.filter((_, i) => i % 3 === 0);
  await db.forGym(gymId, tx => tx.insert(paymentMethods).values(carded.map((p, i) => ({ gymId, householdId: p.id,
    processorId: 'pm_' + i, last4: '4242', isDefault: i !== 0, revokedAt: i === 0 ? clock.now() : null }))));
  const paymentsFor = vi.fn(async () => { throw new Error('The card filter must not call Stripe'); });
  const reads: Read[] = [];
  let inserts = 0;
  const watched = recording(reads);
  const service = createCampaignsService({ scope: (id, fn) => watched(id, tx => fn(new Proxy(tx, { get(target, key) {
    if (key === 'insert') inserts++;
    const value = Reflect.get(target, key) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } }))), clock, jobs: new FakeJobs(clock), delivery: { prepare: vi.fn() }, paymentsFor });
  const c = await service.create({ gymId, actor: { kind: 'system' } }, { name: 'Collect cards', purpose: 'update_card',
    expiresAt: '2026-11-26T12:00:00Z', reminderSchedule: [3], recipients: people.map(p => ({ householdId: p.id })) });
  expect(inserts).toBe(4); // The campaign, one multi-row insert of 320 links and one of their audits, and the campaign audit.
  expect(c.progress).toEqual({ total: size, pending: size, completed: 0, expired: 0, revoked: 0 });

  // 100 used, 40 revoked, 30 expired, 150 pending.
  const ids = (await db.forGym(gymId, tx => tx.select({ id: signedLinks.id }).from(signedLinks).orderBy(asc(signedLinks.id)))).map(r => r.id);
  const used = ids.slice(0, 100), revoked = ids.slice(100, 140), expired = ids.slice(140, 170), pending = ids.slice(170);
  await db.forGym(gymId, async tx => {
    await tx.update(signedLinks).set({ usedAt: clock.now() }).where(inArray(signedLinks.id, used));
    await tx.update(signedLinks).set({ revokedAt: clock.now() }).where(inArray(signedLinks.id, revoked));
    await tx.update(signedLinks).set({ expiresAt: clock.now() }).where(inArray(signedLinks.id, expired));
  });
  const progress = { total: size, completed: 100, revoked: 40, expired: 30, pending: 150 };

  // Progress: one campaign row and one joined aggregate statement, whatever the recipient count.
  reads.length = 0;
  expect((await service.get(gymId, c.campaign.id)).progress).toEqual(progress);
  expect(reads.map(r => r.rows)).toEqual([1, 1]);
  expect(reads.slice(1).every(r => /group by "signed_links"."campaign_id"/.test(r.sql))).toBe(true);
  reads.length = 0;
  expect((await service.list(gymId)).data.map(d => d.progress)).toEqual([progress]);
  expect(Math.max(...reads.map(r => r.rows))).toBe(1);

  // Recipients: a page of the state's links in ID order, limited and offset in SQL.
  for (const [state, expected] of [['pending', pending], ['completed', used], ['revoked', revoked], ['expired', expired], [undefined, ids]] as const) {
    reads.length = 0;
    const page = await service.recipients(gymId, c.campaign.id, { ...(state ? { state } : {}), limit: 20, offset: 20 });
    expect(page.pagination, String(state)).toEqual({ total: expected.length, limit: 20, offset: 20 });
    expect(page.data.map(r => r.link.id), String(state)).toEqual(expected.slice(20, 40));
    expect(page.data.every(r => r.state === (state ?? r.state))).toBe(true);
    const listed = reads.at(-1)!;
    expect(reads).toHaveLength(2); // Campaign existence, then count and page in one statement.
    expect(listed.rows).toBe(expected.slice(20, 40).length); expect(listed.sql).toMatch(/limit \$\d+ offset \$\d+/);
    expect(listed.sql).toContain('count(*)');
  }
  expect(await service.recipients(gymId, c.campaign.id, { limit: 20, offset: size + 1 }))
    .toMatchObject({ data: [], pagination: { total: size } });

  // The filter: the gym's households without a usable card, a page at a time, from the database alone.
  const needing = people.filter((_, i) => i % 3 !== 0 || i === 0).map(p => p.id).sort();
  const found: string[] = [];
  reads.length = 0;
  for (let after: string | undefined; ; ) {
    const page = await service.householdsNeedingCard(gymId, { limit: 100, ...(after ? { after } : {}) });
    found.push(...page.data.map(r => r.householdId));
    if (page.pagination.nextAfter === null) break;
    after = page.pagination.nextAfter;
  }
  expect(found).toEqual(needing);
  expect(reads).toHaveLength(Math.ceil(needing.length / 100));
  expect(reads.every(r => r.rows <= 101 && /not exists/.test(r.sql) && !/offset/.test(r.sql))).toBe(true);
  expect(paymentsFor).not.toHaveBeenCalled();
}, 90_000);

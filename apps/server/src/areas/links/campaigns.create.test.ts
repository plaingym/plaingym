// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import { auditEvents, households, linkCampaigns, members, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { CreateLinkCampaignRequest, CreateSignedLinkRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { createCampaignsService } from './campaigns.js';
import { createSignedLinksService } from './service.js';

// Campaign creation batches its links and audits; these tests hold it to the rows one-by-one creation stores.
const db = useTestDatabase(), factory = createFactories(db);
const expiresAt = '2026-11-26T12:00:00.000Z';
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-26T12:00:00Z'), jobs = new FakeJobs(clock);
  await factory('gyms', gymId, { memberEmailsEnabled: true, timezone: 'America/Los_Angeles' });
  const homes = await Promise.all([0, 1, 2].map(i => factory('households', gymId, { name: 'Household ' + i })));
  const invoices = await Promise.all(homes.flatMap(h => [0, 1].map(() => factory('invoices', gymId, { householdId: h.id }))));
  const members = await Promise.all(homes.flatMap(h => [0, 1].map(() => factory('members', gymId, { householdId: h.id }))));
  const user = await factory('authUser', gymId);
  const options = { scope: db.forGym, clock, jobs, delivery: { prepare: vi.fn() }, paymentsFor: vi.fn() };
  const service = createCampaignsService(options), links = createSignedLinksService({ scope: db.forGym, clock });
  const context = { gymId, actor: { kind: 'user' as const, userId: user.id } };
  const requests = {
    onboarding: homes.map(h => ({ householdId: h.id })), update_card: homes.map(h => ({ householdId: h.id })),
    pay_invoice: invoices.map(i => ({ householdId: i.householdId, invoiceId: i.id })),
    sign_waiver: members.map(m => ({ householdId: m.householdId, memberId: m.id })),
  };
  const input = <P extends keyof typeof requests>(purpose: P, recipients: unknown[] = requests[purpose]) =>
    ({ name: 'Batch ' + purpose, purpose, expiresAt, reminderSchedule: [3], recipients }) as CreateLinkCampaignRequest;
  const stored = () => db.forGym(gymId, async tx => ({ campaigns: await tx.select().from(linkCampaigns).orderBy(asc(linkCampaigns.id)),
    links: await tx.select().from(signedLinks).orderBy(asc(signedLinks.id)), audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)) }));
  return { gymId, clock, jobs, options, service, links, context, requests, input, stored };
}
async function bulkHouseholds(gymId: string, count: number) {
  return db.forGym(gymId, tx => tx.insert(households).values(Array.from({ length: count }, (_, i) => ({ gymId, name: 'Bulk ' + i })))
    .returning({ id: households.id }));
}

it.each(['onboarding', 'update_card', 'pay_invoice', 'sign_waiver'] as const)('rejects mixed-case duplicate %s recipients atomically', async purpose => {
  const f = await fixture(), recipient = f.requests[purpose][0]!;
  const upper = Object.fromEntries(Object.entries(recipient).map(([key, value]) => [key, value.toUpperCase()]));
  const message = purpose === 'pay_invoice' ? 'An invoice' : purpose === 'sign_waiver' ? 'A member' : 'A household';
  await expect(f.service.create(f.context, f.input(purpose, [recipient, upper])))
    .rejects.toThrow(`${message} may appear only once`);
  expect(await f.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  expect(f.jobs.jobs).toEqual([]);
});
/** A scope whose transactions report each property read, such as `insert` or `select`, before it happens. */
function watching(onRead: (key: string | symbol) => void): typeof db.forGym {
  return (gymId, fn) => db.forGym(gymId, tx => fn(new Proxy(tx, { get(target, key) {
    onRead(key);
    const value = Reflect.get(target, key) as unknown;
    return typeof value === 'function' ? value.bind(target) : value;
  } })));
}
/** A link or its audit without generated IDs, times, the random hash or the campaign it belongs to. */
function comparable(rows: Record<string, unknown>[]) {
  const omit = new Set(['id', 'createdAt', 'occurredAt', 'tokenHash', 'campaignId', 'targetId']);
  const strip = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row)
    .filter(([key]) => !omit.has(key)).map(([key, value]) => [key, key === 'after' && value ? strip(value as Record<string, unknown>) : value]));
  return rows.map(strip).map(row => JSON.stringify(row)).sort();
}

it.each(['onboarding', 'update_card', 'pay_invoice', 'sign_waiver'] as const)('stores the %s links and audits one-by-one creation stores', async purpose => {
  const f = await fixture();
  const batched = await f.service.create(f.context, f.input(purpose));
  const reference = await factory('linkCampaigns', f.gymId, { purpose });
  for (const recipient of f.requests[purpose])
    await f.links.create(f.context, { purpose, expiresAt, campaignId: reference.id, ...recipient } as CreateSignedLinkRequest);
  const read = (campaignId: string) => db.forGym(f.gymId, async tx => {
    const links = await tx.select().from(signedLinks).where(inArray(signedLinks.campaignId, [campaignId]));
    const audits = await tx.select().from(auditEvents).where(inArray(auditEvents.targetId, links.map(l => l.id)));
    return { links, audits };
  });
  const [mine, theirs] = [await read(batched.campaign.id), await read(reference.id)];
  expect(mine.links).toHaveLength(f.requests[purpose].length);
  expect(comparable(mine.links)).toEqual(comparable(theirs.links));
  expect(comparable(mine.audits)).toEqual(comparable(theirs.audits));
  for (const link of mine.links) {
    expect(link).toMatchObject({ campaignId: batched.campaign.id, createdAt: f.clock.now(), createdBy: f.context.actor.userId });
    const audit = mine.audits.filter(a => a.targetId === link.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'signed_link.created', occurredAt: f.clock.now(), after: { id: link.id, campaignId: batched.campaign.id } });
  }
  expect(new Set([...mine.links, ...theirs.links].map(l => l.tokenHash)).size).toBe(mine.links.length * 2);
});

it('returns each fresh token with its stored SHA-256 digest, in request order', async () => {
  const f = await fixture();
  const requests = f.requests.pay_invoice.map(r => ({ purpose: 'pay_invoice' as const, expiresAt, ...r }));
  const created = await f.links.createMany(f.context, requests);
  expect(created.map(c => c.link.invoiceId)).toEqual(requests.map(r => r.invoiceId));
  const { links } = await f.stored();
  for (const { link, token } of created) {
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(links.find(l => l.id === link.id)!.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(await f.links.resolve(f.gymId, token)).toMatchObject({ status: 'active', principal: { linkId: link.id } });
  }
  expect(new Set(created.map(c => c.token)).size).toBe(requests.length);
});

it('rejects duplicate recipients for every purpose, but gives one household a link per invoice and member', async () => {
  const f = await fixture();
  for (const purpose of ['onboarding', 'update_card', 'pay_invoice', 'sign_waiver'] as const) {
    const [first, second] = f.requests[purpose];
    await expect(f.service.create(f.context, f.input(purpose, [first, second, first]))).rejects.toThrow();
  }
  expect(await f.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  expect(f.jobs.jobs).toEqual([]);
  const [household] = f.requests.onboarding;
  for (const purpose of ['pay_invoice', 'sign_waiver'] as const) {
    const siblings = f.requests[purpose].filter(r => r.householdId === household!.householdId);
    expect(siblings).toHaveLength(2);
    const created = await f.service.create(f.context, f.input(purpose, siblings));
    expect(created.progress).toMatchObject({ total: 2, pending: 2 });
  }
  const { links } = await f.stored();
  expect(new Set(links.map(l => l.tokenHash)).size).toBe(4);
});

it('leaves nothing behind when a later recipient fails its check, in a later chunk or after valid ones', async () => {
  const f = await fixture(), other = await fixture();
  const recipients = (await bulkHouseholds(f.gymId, 1200)).map(h => ({ householdId: h.id }));
  for (const [index, recipient, code] of [[1100, other.requests.onboarding[0]!, 'not_found'], [1199, { householdId: uuidv7() }, 'not_found']] as const) {
    const input = f.input('update_card', recipients.map((r, i) => i === index ? recipient : r));
    await expect(f.service.create(f.context, input)).rejects.toMatchObject({ code });
  }
  const member = await factory('members', f.gymId, { householdId: recipients[0]!.householdId, anonymizedAt: f.clock.now() });
  const waivers = [...f.requests.sign_waiver, { householdId: member.householdId, memberId: member.id }];
  await expect(f.service.create(f.context, f.input('sign_waiver', waivers))).rejects.toMatchObject({ code: 'conflict' });
  expect(await f.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  expect(f.jobs.jobs).toEqual([]);
});

it('rolls back the campaign, earlier chunks and their audits when a later insert fails', async () => {
  const f = await fixture();
  const recipients = (await bulkHouseholds(f.gymId, 1200)).map(h => ({ householdId: h.id }));
  let inserts = 0;
  // The campaign, then the first chunk's links and audits commit to the transaction before the second chunk's links fail.
  const service = createCampaignsService({ ...f.options, scope: watching(key => {
    if (key === 'insert' && ++inserts === 4) throw new Error('Insert failed');
  }) });
  await expect(service.create(f.context, f.input('update_card', recipients))).rejects.toThrow('Insert failed');
  expect(inserts).toBe(4);
  expect(await f.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  expect(f.jobs.jobs).toEqual([]);
  const created = await f.service.create(f.context, f.input('update_card', recipients));
  expect(created.progress.total).toBe(1200);
});

it("keeps gym A's batched links and audits from gym B", async () => {
  const a = await fixture(), b = await fixture();
  const created = await a.service.create(a.context, a.input('pay_invoice'));
  const tokens = await a.links.createMany(a.context, a.requests.update_card.map(r => ({ purpose: 'update_card' as const, expiresAt, ...r })));
  const own = await a.stored();
  expect(own.links).toHaveLength(9);
  expect(await b.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  for (const link of own.links) await expect(b.links.get(b.gymId, link.id)).rejects.toMatchObject({ code: 'not_found' });
  for (const { token } of tokens) expect(await b.links.resolve(b.gymId, token)).toEqual({ status: 'not_found' });
  expect((await b.links.list(b.gymId, { campaignId: created.campaign.id })).data).toEqual([]);
  await expect(b.service.get(b.gymId, created.campaign.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(b.service.recipients(b.gymId, created.campaign.id)).rejects.toMatchObject({ code: 'not_found' });
  // Gym B cannot batch links for gym A's households, invoices or members either.
  for (const purpose of ['update_card', 'pay_invoice', 'sign_waiver'] as const)
    await expect(b.service.create(b.context, b.input(purpose, a.requests[purpose]))).rejects.toMatchObject({ code: 'not_found' });
  expect(await b.stored()).toEqual({ campaigns: [], links: [], audits: [] });
  expect(await a.stored()).toEqual(own);
});

it('orders link and audit IDs as the recipients were submitted, across chunks', async () => {
  const f = await fixture();
  const recipients = (await bulkHouseholds(f.gymId, 1200)).map(h => ({ householdId: h.id })).reverse();
  const created = await f.service.create(f.context, f.input('update_card', recipients));
  const { links, audits } = await db.forGym(f.gymId, async tx => ({
    links: await tx.select().from(signedLinks).orderBy(asc(signedLinks.id)),
    audits: await tx.select().from(auditEvents).where(eq(auditEvents.action, 'signed_link.created')).orderBy(asc(auditEvents.id)),
  }));
  expect(links.map(l => l.householdId)).toEqual(recipients.map(r => r.householdId));
  expect(audits.map(a => a.targetId)).toEqual(links.map(l => l.id));
  const page = await f.service.recipients(f.gymId, created.campaign.id, { limit: 50, offset: 600 });
  expect(page.data.map(r => r.link.householdId)).toEqual(recipients.slice(600, 650).map(r => r.householdId));
});

it('accepts uppercase resource IDs, as PostgreSQL matched them before batching, and stores them canonically', async () => {
  const f = await fixture();
  const upper = <T extends Record<string, string>>(r: T) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toUpperCase()])) as T;
  for (const purpose of ['update_card', 'pay_invoice', 'sign_waiver'] as const) {
    const created = await f.service.create(f.context, f.input(purpose, f.requests[purpose].map(upper)));
    expect(created.progress.total).toBe(f.requests[purpose].length);
  }
  const { links } = await f.stored();
  for (const purpose of ['update_card', 'pay_invoice', 'sign_waiver'] as const)
    expect(links.filter(l => l.purpose === purpose)).toHaveLength(f.requests[purpose].length);
  expect(links.filter(l => l.purpose === 'sign_waiver').map(l => l.memberId).sort())
    .toEqual(f.requests.sign_waiver.map(r => r.memberId).sort());
});

it('locks waiver members in one order across chunks, so overlapping campaigns in opposite orders both commit', async () => {
  const f = await fixture();
  const [home] = await bulkHouseholds(f.gymId, 1);
  const people = await db.forGym(f.gymId, tx => tx.insert(members).values(Array.from({ length: 1000 }, (_, i) => ({
    gymId: f.gymId, householdId: home!.id, firstName: 'Member', lastName: String(i) }))).returning({ id: members.id }));
  const recipients = people.map(p => ({ householdId: home!.id, memberId: p.id }));
  const results = await Promise.allSettled([f.service.create(f.context, f.input('sign_waiver', recipients)),
    f.service.create(f.context, f.input('sign_waiver', [...recipients].reverse()))]);
  expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
  expect((await f.stored()).links).toHaveLength(2000);
});

it('rejects an expired campaign before looking up or locking any recipient', async () => {
  const f = await fixture();
  const reads: (string | symbol)[] = [];
  const service = createCampaignsService({ ...f.options, scope: watching(key => reads.push(key)) });
  const input = { ...f.input('sign_waiver'), expiresAt: f.clock.now().toISOString() };
  await expect(service.create(f.context, input)).rejects.toMatchObject({ code: 'invalid_request' });
  expect(reads.filter(key => key === 'select')).toEqual([]);
  expect(await f.stored()).toEqual({ campaigns: [], links: [], audits: [] });
});

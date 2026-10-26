// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, forGym, households, importChunks, importRuns, invoices, members, memberships, plans, RevisionConflictError, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest, ImportTargetField } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createGymSettingsAccessor } from '../../settings/settings.js';
import { createMembershipService } from '../../billing/memberships.js';
import { createChargeRunner } from '../../billing/runner/index.js';
import { createInvoiceTransitions } from '../../billing/transitions/index.js';
import { autoMatch, csvLine, parseCsv } from '../pipeline.csv.js';
import { createImportPipeline } from '../pipeline.js';
import { membershipsMapper } from './memberships.js';
import { MapperRegistry, type MapperContext, type PlannedRow } from './registry.js';

const database = useTestDatabase(), factory = createFactories(database);
let gymId: string, otherGym: string, clock: TestClock;
beforeEach(async () => {
  clock = new TestClock('2026-10-26T12:00:00Z'); gymId = uuidv7(); otherGym = uuidv7();
  await factory('gyms', gymId, { timezone: 'America/Vancouver', currency: 'CAD', billingEnabled: true });
  await factory('gyms', otherGym, { currency: 'CAD' });
});
async function fixture(interval = 'monthly', homeId?: string, gym = gymId) {
  const home = homeId ? (await database.forGym(gym, tx => tx.select().from(households).where(eq(households.id, homeId))))[0]!
    : await factory('households', gym, { billingDay: 1, stripeCustomerId: 'cus_' + uuidv7() });
  const member = await factory('members', gym, { householdId: home.id, email: uuidv7() + '@example.test', firstName: uuidv7(), lastName: 'Private%Name' });
  const plan = await factory('plans', gym, { name: uuidv7(), interval, amountCents: 10000, trialDays: 7, signupFeeCents: 5000 });
  return { home, member, plan };
}
type Cells = Partial<Record<ImportTargetField, string>>;
const csv = (records: Cells[]) => {
  const fields = [...new Set(records.flatMap(record => Object.keys(record)))];
  return csvLine(fields) + records.map(record => csvLine(fields.map(field => record[field as ImportTargetField] ?? ''))).join('');
};
function services(scope = database.forGym, registry?: MapperRegistry) {
  const storage = new Map<string, FakeUploads>(), jobs = new FakeJobs(clock);
  const uploadsFor = async (gym: string) => {
    if (!storage.has(gym)) storage.set(gym, new FakeUploads(gym, clock));
    return storage.get(gym)!;
  };
  const pipeline = createImportPipeline({ scope, clock, jobs, uploadsFor, ...(registry ? { mappers: registry } : {}) });
  async function load(records: Cells[], duplicatePolicy: ImportPlanRequest['duplicatePolicy'] = 'error', gym = gymId) {
    const actor = { gymId: gym, actor: { kind: 'system' } } as const, text = csv(records);
    const upload = await pipeline.upload(actor, new File([text], 'renewals.csv'));
    const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'memberships', duplicatePolicy, mapping: autoMatch(parseCsv(text).columns) };
    return { actor, plan, preview: () => pipeline.preview(actor, plan, { limit: 100, offset: 0 }, 'America/Vancouver'),
      async run(dryRun = false) {
        const job = await pipeline.start(actor, { ...plan, dryRun }, 'America/Vancouver');
        await pipeline.run(gym, job.id);
        return pipeline.get(gym, job.id);
      } };
  }
  return { pipeline, jobs, uploadsFor, load };
}
const read = (gym = gymId) => database.forGym(gym, async tx => ({
  memberships: await tx.select().from(memberships).orderBy(asc(memberships.id)),
  homes: await tx.select().from(households).orderBy(asc(households.id)),
  invoices: await tx.select().from(invoices).orderBy(asc(invoices.dueOn)),
  audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
}));
async function analyzed(records: Cells[], duplicatePolicy: ImportPlanRequest['duplicatePolicy'] = 'error') {
  const text = csv(records), document = parseCsv(text), context: MapperContext = {
    gymId, actor: { kind: 'system' }, clock, runId: uuidv7(), timezone: 'America/Vancouver', sourceRows: document.rows,
  };
  const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'memberships', mapping: autoMatch(document.columns), duplicatePolicy };
  const planned = await database.forGym(gymId, tx => membershipsMapper.analyze(tx, document.rows, plan, context));
  return { context, planned, commit: (rows: PlannedRow[] = planned) => database.forGym(gymId, tx => membershipsMapper.commit(tx, rows, context)) };
}
async function runner(f: Awaited<ReturnType<typeof fixture>>) {
  await factory('paymentMethods', gymId, { householdId: f.home.id, processorId: 'pm_saved', isDefault: true });
  const provider = new FakePayments(gymId, clock); provider.seedCustomer({ id: f.home.stripeCustomerId!, email: 'payer@example.test' });
  const options = { scope: database.forGym, clock, jobs: new FakeJobs(clock), settings: createGymSettingsAccessor({ scope: database.forGym }) };
  const service = createChargeRunner({ ...options, transitions: createInvoiceTransitions(options), payments: async () => provider });
  return { provider, daily: () => service.daily(gymId) };
}
async function spanningFamily(status = 'active', startsOn = '2026-01-15') {
  const first = await fixture(), sibling = await fixture('monthly', first.home.id);
  await factory('memberships', gymId, { householdId: first.home.id, memberId: first.member.id, planId: first.plan.id,
    startsOn: '2026-01-15', nextDueOn: '2026-11-15', status: 'active' });
  const later = await factory('memberships', gymId, { householdId: first.home.id, memberId: sibling.member.id, planId: sibling.plan.id,
    startsOn, nextDueOn: startsOn > '2026-11-15' ? '2027-11-15' : '2026-11-15', status,
    ...(status === 'trial' ? { trialEndsOn: '2026-11-15' } : {}), ...(status === 'frozen' ? { frozenAt: clock.now() } : {}) });
  await database.forGym(gymId, tx => tx.update(households).set({ billingDay: 15 }).where(eq(households.id, first.home.id)));
  const records: Cells[] = [{ email: first.member.email!, plan: first.plan.id, nextDueOn: '2026-11-20' }];
  for (let i = 0; i < 99; i++) {
    const member = await factory('members', gymId, { householdId: first.home.id, email: `future-${i}@example.test` });
    records.push({ email: member.email!, plan: first.plan.id, interval: 'annual', nextDueOn: '2028-01-01' });
  }
  records.push({ email: sibling.member.email!, plan: sibling.plan.id, nextDueOn: '2026-11-20', amountCents: '7000' });
  return { first, sibling, later, records };
}

describe('membership renewals through the durable pipeline', () => {
  it('bills the imported monthly date and price, with the next cycle on the household anchor', async () => {
    const f = await fixture(), source = await services().load([{ email: f.member.email!, plan: f.plan.name,
      amountCents: '8250', interval: 'monthly', currency: 'cad', nextDueOn: '2026-11-19', commitmentEndsOn: '2027-11-19' }]);
    expect((await source.run()).committedRows).toBe(1);
    expect((await read()).memberships[0]).toMatchObject({ amountCents: 8250, status: 'active', interval: 'monthly',
      startsOn: '2026-10-26', nextDueOn: '2026-11-19', anniversaryOn: null, commitmentEndsOn: '2027-11-19' });
    expect((await read()).homes[0]).toMatchObject({ billingDay: 19, revision: 2 });
    const run = await runner(f); await run.daily(); expect((await read()).invoices).toEqual([]);
    clock.set('2026-11-19T17:00:00Z'); await run.daily();
    expect((await read()).invoices).toEqual([expect.objectContaining({ dueOn: '2026-11-19', status: 'paid', amountCents: 8250 })]);
    expect((await read()).memberships[0]!.nextDueOn).toBe('2026-12-19');
    const audits = (await read()).audits.filter(row => row.action.startsWith('billing.membership.import') || row.action === 'billing.household.anchor_set');
    const data = JSON.stringify(audits);
    for (const pii of [f.member.email!, f.member.firstName, f.member.lastName, f.plan.name, f.home.stripeCustomerId!]) expect(data).not.toContain(pii);
    expect(audits.every(row => row.occurredAt.toISOString() === '2026-10-26T12:00:00.000Z')).toBe(true);
  });
  it('keeps a future annual date separate from monthly billing and bills February 29 again in the next leap year', async () => {
    const monthly = await fixture(), annual = await fixture('annual', monthly.home.id);
    const source = await services().load([
      { email: monthly.member.email!, plan: monthly.plan.id, nextDueOn: '2026-11-15' },
      { email: annual.member.email!, plan: annual.plan.id, nextDueOn: '2028-02-29' },
    ]);
    expect((await source.run()).committedRows).toBe(2);
    expect((await read()).homes[0]!.billingDay).toBe(15);
    const annualRow = (await read()).memberships.find(row => row.memberId === annual.member.id)!;
    expect(annualRow).toMatchObject({ nextDueOn: '2028-02-29', anniversaryOn: '2028-02-29', interval: 'annual' });
    // Isolate the annual renewal after proving the shared household anchor.
    await database.forGym(gymId, tx => tx.update(memberships).set({ status: 'cancelled' }).where(eq(memberships.memberId, monthly.member.id)));
    const run = await runner(monthly); clock.set('2028-02-28T17:00:00Z'); await run.daily(); expect((await read()).invoices).toEqual([]);
    for (const due of ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']) {
      clock.set(due + 'T17:00:00Z'); await run.daily();
      expect((await read()).invoices.find(row => row.dueOn === due)).toMatchObject({ status: 'paid', amountCents: 10000 });
    }
    expect((await read()).memberships.find(row => row.id === annualRow.id)!.anniversaryOn).toBe('2028-02-29');
  });
  it('an annual-only import leaves the household monthly anchor unchanged', async () => {
    const f = await fixture('annual');
    await (await services().load([{ email: f.member.email!, plan: f.plan.name, nextDueOn: '2027-07-23' }])).run();
    expect((await read()).homes[0]).toMatchObject({ billingDay: 1, revision: 1 });
  });
  it('allows an imported future-date typo to be corrected by reimport and by the membership service', async () => {
    const f = await fixture('annual'), service = services(), row = { email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-11-15' };
    await (await service.load([row])).run();
    expect((await (await service.load([{ ...row, nextDueOn: '2026-11-15' }], 'update')).run()).committedRows).toBe(1);
    const imported = (await read()).memberships[0]!;
    expect(imported).toMatchObject({ startsOn: '2026-10-26', nextDueOn: '2026-11-15' });
    const lifecycle = createMembershipService({ scope: database.forGym, clock, settings: createGymSettingsAccessor({ scope: database.forGym }) });
    expect(await lifecycle.update({ gymId, actor: { kind: 'system' } }, { membershipId: imported.id, revision: imported.revision, nextDueOn: '2026-11-01' }))
      .toMatchObject({ nextDueOn: '2026-11-01', startsOn: '2026-10-26' });
  });
  it('sets startsOn from the gym local day, or the earlier source date', async () => {
    clock.set('2026-10-26T02:00:00Z');
    const future = await fixture('annual'), past = await fixture('annual');
    await (await services().load([
      { email: future.member.email!, plan: future.plan.id, nextDueOn: '2027-11-15' },
      { email: past.member.email!, plan: past.plan.id, nextDueOn: '2026-10-20' },
    ])).run();
    const after = (await read()).memberships;
    expect(after.find(row => row.memberId === future.member.id)!.startsOn).toBe('2026-10-25');
    expect(after.find(row => row.memberId === past.member.id)!.startsOn).toBe('2026-10-20');
  });
  it('reports an update before startsOn as a row error while other rows commit', async () => {
    const f = await fixture('annual'), good = await fixture('annual'), service = services();
    await (await service.load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-11-15' }])).run();
    const before = (await read()).memberships[0]!;
    const source = await service.load([
      { email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-10-01' },
      { email: good.member.email!, plan: good.plan.id, nextDueOn: '2027-12-01' },
    ], 'update');
    expect((await source.preview()).summary).toMatchObject({ create: 1, update: 0, errors: 1 });
    const job = await source.run(); expect(job).toMatchObject({ committedRows: 1, errorCount: 1, processedRows: 2 });
    expect((await service.pipeline.errors(gymId, job.id, { limit: 100, offset: 0 })).data).toEqual([
      expect.objectContaining({ rowNumber: 2, column: 'nextDueOn', message: 'The next billing date cannot be before the membership start date.' }),
    ]);
    expect((await read()).memberships.find(row => row.id === before.id)).toEqual(before);
  });
  it.each(['create', 'update'] as const)('recovers a February 29 anniversary from a clamped non-leap renewal on %s', async mode => {
    const f = await fixture('annual'), service = services(), row = { email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-02-28' };
    if (mode === 'update') await (await service.load([row])).run();
    const source = await service.load([{ ...row, billingDay: '29' }], mode === 'update' ? 'update' : 'error');
    expect((await source.run()).committedRows).toBe(1);
    const imported = (await read()).memberships[0]!;
    expect(imported.anniversaryOn).toBe('2028-02-29'); expect(imported.nextDueOn).toBe('2027-02-28');
    const run = await runner(f);
    for (const due of ['2027-02-28', '2028-02-29']) {
      clock.set(due + 'T17:00:00Z'); await run.daily();
      expect((await read()).invoices.find(invoice => invoice.dueOn === due)).toMatchObject({ status: 'paid', amountCents: 10000 });
      expect((await read()).memberships[0]!.anniversaryOn).toBe('2028-02-29');
    }
  });
  it.each([
    ['2027-02-28', '30'], ['2027-03-28', '29'], ['2028-02-28', '29'], ['2027-07-15', '14'],
  ])('rejects an annual anniversary day inconsistent with %s: %s', async (nextDueOn, billingDay) => {
    const f = await fixture('annual'), source = await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn, billingDay }]);
    expect((await source.preview()).summary.errors).toBe(1); expect((await source.run()).committedRows).toBe(0);
  });
  it('accepts an explicit matching annual day and allows it to replace a leap anniversary on update', async () => {
    const f = await fixture('annual'), service = services(), row = { email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-02-28' };
    await (await service.load([{ ...row, billingDay: '29' }])).run();
    expect((await (await service.load([{ ...row, billingDay: '28' }], 'update')).run()).committedRows).toBe(1);
    expect((await read()).memberships[0]!.anniversaryOn).toBe('2027-02-28');
  });
  it('reports a mismatched annual day on update without changing the existing membership', async () => {
    const f = await fixture('annual'), service = services(), row = { email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-07-15' };
    await (await service.load([row])).run(); const before = (await read()).memberships[0]!;
    const source = await service.load([{ ...row, billingDay: '14' }], 'update');
    expect((await source.preview()).summary).toMatchObject({ errors: 1, update: 0 });
    const job = await source.run(); expect(job).toMatchObject({ committedRows: 0, errorCount: 1 });
    expect((await service.pipeline.errors(gymId, job.id, { limit: 100, offset: 0 })).data[0]).toMatchObject({ column: 'billingDay', code: 'invalid_value' });
    expect((await read()).memberships[0]).toEqual(before);
  });
  it.each(['trial', 'frozen'])('ignores an existing off-anchor %s date when importing a monthly renewal', async status => {
    const f = await fixture(), other = await fixture('monthly', f.home.id);
    const original = await factory('memberships', gymId, { householdId: f.home.id, memberId: other.member.id, planId: other.plan.id,
      status, startsOn: '2026-10-01', nextDueOn: '2026-11-10', ...(status === 'trial' ? { trialEndsOn: '2026-11-10' } : { frozenAt: clock.now() }) });
    const source = await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' }]);
    expect((await source.preview()).summary).toMatchObject({ create: 1, errors: 0 });
    expect((await source.run()).committedRows).toBe(1);
    expect((await read()).memberships.find(row => row.id === original.id)).toEqual(original);
  });
  it('preview and dry run preserve domain rows and audits', async () => {
    const f = await fixture(), before = await read(), source = await services().load([{ email: f.member.email!, plan: f.plan.name, nextDueOn: '2026-12-07' }]);
    const uploaded = await read();
    expect((await source.preview()).summary).toMatchObject({ create: 1, errors: 0 });
    expect((await source.run(true)).committedRows).toBe(0); expect(await read()).toEqual(uploaded);
    expect(uploaded.memberships).toEqual(before.memberships); expect(uploaded.homes).toEqual(before.homes);
  });
  it('supports duplicate error, skip and revision-checked update without duplicating or charging on import', async () => {
    const f = await fixture('annual'), service = services(), record = { email: f.member.email!, plan: f.plan.name, nextDueOn: '2028-02-29' };
    await (await service.load([record])).run();
    expect((await (await service.load([record])).preview()).summary.errors).toBe(1);
    expect((await (await service.load([record], 'skip')).run()).committedRows).toBe(0);
    expect((await (await service.load([{ ...record, nextDueOn: '2029-02-28', amountCents: '7000' }], 'update')).run()).committedRows).toBe(1);
    expect((await read()).memberships).toEqual([expect.objectContaining({ amountCents: 7000, nextDueOn: '2029-02-28', anniversaryOn: '2028-02-29', revision: 2 })]);
    expect((await read()).invoices).toEqual([]);
  });
  it.each(['member', 'household', 'plan', 'membership'] as const)('refuses stale %s revisions atomically', async changed => {
    const f = await fixture();
    await (await services().load([{ email: f.member.email!, plan: f.plan.name, nextDueOn: '2026-11-15' }])).run();
    const batch = await analyzed([{ email: f.member.email!, plan: f.plan.name, nextDueOn: '2026-12-15' }], 'update');
    expect(batch.planned[0]!.issues).toEqual([]);
    await database.forGym(gymId, async tx => {
      if (changed === 'member') await tx.update(members).set({ revision: 2 }).where(eq(members.id, f.member.id));
      if (changed === 'household') await tx.update(households).set({ revision: 3 }).where(eq(households.id, f.home.id));
      if (changed === 'plan') await tx.update(plans).set({ revision: 2 }).where(eq(plans.id, f.plan.id));
      if (changed === 'membership') await tx.update(memberships).set({ revision: 2 }).where(eq(memberships.memberId, f.member.id));
    });
    const before = await read();
    await expect(batch.commit(batch.planned.map(row => ({ ...row, action: 'update' })))).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await read()).toEqual(before);
  });
  it('serializes concurrent create commits and rejects oversized chunks', async () => {
    const f = await fixture('annual'), batch = await analyzed([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2028-06-21' }]);
    expect((await Promise.all([batch.commit(), batch.commit()])).sort()).toEqual([0, 1]);
    expect((await read()).memberships).toHaveLength(1);
    await expect(batch.commit(Array.from({ length: 101 }, () => batch.planned[0]!))).rejects.toThrow('100');
  });
  it('reports unknown, ambiguous, erased, inactive and foreign references and mismatched currency', async () => {
    const f = await fixture(), foreign = await fixture('monthly', undefined, otherGym), same = await fixture();
    await factory('members', gymId, { email: same.member.email });
    const inactive = await factory('plans', gymId, { name: 'Inactive', active: false });
    const erased = await fixture(); await database.forGym(gymId, tx => tx.update(members).set({ anonymizedAt: clock.now() }).where(eq(members.id, erased.member.id)));
    const before = await read(otherGym), batch = await analyzed([
      { email: foreign.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' },
      { email: f.member.email!, plan: foreign.plan.id, nextDueOn: '2026-11-15' },
      { email: same.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' },
      { email: f.member.email!, plan: inactive.id, nextDueOn: '2026-11-15' },
      { email: erased.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' },
      { email: f.member.email!, plan: f.plan.id, currency: 'USD', nextDueOn: '2026-11-15' },
    ]);
    expect(batch.planned.every(row => row.action === 'error')).toBe(true); expect(await batch.commit()).toBe(0);
    expect(await read(otherGym)).toEqual(before);
  });
  it('resolves names with literal wildcards and uses all supplied identity fields', async () => {
    const f = await fixture(), batch = await analyzed([{ firstName: f.member.firstName, lastName: f.member.lastName, plan: f.plan.id, nextDueOn: '2026-11-17' }]);
    expect(batch.planned[0]!.values.memberId).toBe(f.member.id); expect(await batch.commit()).toBe(1);
    const wrong = await analyzed([{ email: f.member.email!, firstName: 'Somebody else', plan: f.plan.id, nextDueOn: '2026-11-17' }]);
    expect(wrong.planned[0]!.action).toBe('error');
  });
  it('validates household anchors across chunks, accepts short-month clamps and rejects conflicting monthly dates', async () => {
    const first = await fixture(), second = await fixture('monthly', first.home.id);
    const source = await services().load([
      { email: first.member.email!, plan: first.plan.id, nextDueOn: '2027-02-28', billingDay: '31' },
      { email: second.member.email!, plan: second.plan.id, nextDueOn: '2027-03-31' },
    ]);
    expect((await source.run()).committedRows).toBe(2); expect((await read()).homes[0]!.billingDay).toBe(31);
    const bad = await services().load([
      { email: first.member.email!, plan: first.plan.id, nextDueOn: '2027-04-15' },
      { email: second.member.email!, plan: second.plan.id, nextDueOn: '2027-04-20' },
    ], 'update');
    expect((await bad.preview()).summary.errors).toBe(2);
  });
  it('keeps the first monthly row importable when a later duplicate supplies a different date', async () => {
    const f = await fixture(), source = await services().load([
      { email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' },
      { firstName: f.member.firstName, lastName: f.member.lastName, plan: f.plan.id, nextDueOn: '2026-11-20' },
    ]);
    expect((await source.preview()).summary).toMatchObject({ create: 1, errors: 1 });
    expect((await source.run()).committedRows).toBe(1);
    expect((await read()).memberships[0]!.nextDueOn).toBe('2026-11-15');
    expect((await read()).homes[0]!.billingDay).toBe(15);
  });
  it('preserves a compatible existing 31st anchor when the next imported date falls in February', async () => {
    const f = await fixture(); await database.forGym(gymId, tx => tx.update(households).set({ billingDay: 31 }).where(eq(households.id, f.home.id)));
    const source = await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2027-02-28' }]);
    expect((await source.run()).committedRows).toBe(1); expect((await read()).homes[0]!.billingDay).toBe(31);
    const run = await runner(f); clock.set('2027-02-28T17:00:00Z'); await run.daily();
    expect((await read()).memberships[0]!.nextDueOn).toBe('2027-03-31');
  });
  it('validates a monthly conflict in a later chunk before importing the first family row', async () => {
    const f = await fixture(), other = await fixture('monthly', f.home.id);
    const filler = await fixture('annual');
    const records: Cells[] = [{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' },
      ...Array.from({ length: 99 }, () => ({ email: filler.member.email!, plan: filler.plan.id, nextDueOn: '2027-01-01' })),
      { email: other.member.email!, plan: other.plan.id, nextDueOn: '2026-11-20' }];
    const document = parseCsv(csv(records)), context: MapperContext = { gymId, actor: { kind: 'system' }, clock, runId: uuidv7(), timezone: 'America/Vancouver', sourceRows: document.rows };
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'memberships', mapping: autoMatch(document.columns), duplicatePolicy: 'skip' };
    const planned = await database.forGym(gymId, tx => membershipsMapper.analyze(tx, document.rows.slice(0, 100), plan, context));
    expect(planned[0]!.issues).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });
  it('updates one household schedule when its monthly memberships span chunks', async () => {
    const f = await fixture(), other = await fixture('monthly', f.home.id);
    for (const person of [f, other]) await factory('memberships', gymId, { householdId: f.home.id, memberId: person.member.id,
      planId: person.plan.id, startsOn: '2026-01-15', nextDueOn: '2026-11-15', status: 'active' });
    await database.forGym(gymId, tx => tx.update(households).set({ billingDay: 15 }).where(eq(households.id, f.home.id)));
    const records: Cells[] = [{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-20' }];
    for (let i = 0; i < 99; i++) {
      const member = await factory('members', gymId, { householdId: f.home.id, email: `future-${i}@example.test` });
      records.push({ email: member.email!, plan: f.plan.id, interval: 'annual', nextDueOn: '2028-01-01' });
    }
    records.push({ email: other.member.email!, plan: other.plan.id, nextDueOn: '2026-11-20' });
    const source = await services().load(records, 'update');
    expect((await source.preview()).summary).toMatchObject({ create: 99, update: 2, errors: 0 });
    expect(await source.run()).toMatchObject({ status: 'succeeded', committedRows: 101, errorCount: 0 });
    const after = await read(); expect(after.homes[0]!.billingDay).toBe(20);
    expect(after.memberships.filter(row => row.interval === 'monthly').map(row => row.nextDueOn)).toEqual(['2026-11-20', '2026-11-20']);
  });
  it('rechecks a later planned schedule update before changing the household anchor', async () => {
    const f = await fixture(), other = await fixture('monthly', f.home.id);
    for (const person of [f, other]) await factory('memberships', gymId, { householdId: f.home.id, memberId: person.member.id,
      planId: person.plan.id, startsOn: '2026-01-15', nextDueOn: '2026-11-15', status: 'active' });
    const batch = await analyzed([
      { email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-20' },
      { email: other.member.email!, plan: other.plan.id, nextDueOn: '2026-11-20' },
    ], 'update');
    expect(batch.planned.every(row => row.issues.length === 0)).toBe(true);
    await database.forGym(gymId, tx => tx.update(memberships).set({ revision: 2 }).where(eq(memberships.memberId, other.member.id)));
    const before = await read();
    await expect(batch.commit([{ ...batch.planned[0]!, action: 'update' }])).rejects.toBeInstanceOf(RevisionConflictError);
    expect(await read()).toEqual(before);
  });
  it('moves dependent monthly dates with the anchor even when the later chunk rolls back', async () => {
    const family = await spanningFamily();
    const mapper = { ...membershipsMapper, async commit(...args: Parameters<typeof membershipsMapper.commit>) {
      const count = await membershipsMapper.commit(...args);
      if (args[1].some(row => row.values.memberId === family.sibling.member.id)) throw new Error('later chunk rolled back');
      return count;
    } };
    const service = services(database.forGym, new MapperRegistry([mapper])), source = await service.load(family.records, 'update');
    const job = await source.run(); expect(job).toMatchObject({ status: 'failed', processedRows: 101, committedRows: 100, errorCount: 1 });
    const after = await read(), later = after.memberships.find(row => row.id === family.later.id)!;
    expect(after.homes[0]!.billingDay).toBe(20);
    expect(after.memberships.filter(row => row.interval === 'monthly').every(row => row.nextDueOn === '2026-11-20')).toBe(true);
    expect(later).toMatchObject({ revision: 2, amountCents: 10000, nextDueOn: '2026-11-20' });
    const schedules = after.audits.filter(event => event.action === 'billing.membership.import_schedule_updated');
    expect(schedules).toEqual([expect.objectContaining({ targetId: later.id, after: expect.objectContaining({
      importId: job.id, previousDueOn: '2026-11-15', nextDueOn: '2026-11-20',
    }) })]);
    expect(JSON.stringify(schedules)).not.toContain(family.sibling.member.email!);
    // Reanalysis sees the revision from the atomic anchor move and can apply the remaining fields.
    const retry = await services().load([family.records.at(-1)!], 'update'); expect((await retry.run()).committedRows).toBe(1);
    expect((await read()).memberships.find(row => row.id === later.id)).toMatchObject({ revision: 3, amountCents: 7000, nextDueOn: '2026-11-20' });
  });
  it.each(['trial', 'frozen', 'before-start'])('reports a later-chunk %s sibling as a row error without failing valid chunks', async reason => {
    const family = await spanningFamily(reason === 'before-start' ? 'active' : reason, reason === 'before-start' ? '2027-01-15' : '2026-01-15');
    const service = services(), source = await service.load(family.records, 'update');
    const expectedErrors = reason === 'before-start' ? 2 : 1;
    expect((await source.preview()).summary).toMatchObject({ errors: expectedErrors });
    const job = await source.run(); expect(job).toMatchObject({ processedRows: 101, committedRows: 101 - expectedErrors, errorCount: expectedErrors });
    const errors = (await service.pipeline.errors(gymId, job.id, { limit: 100, offset: 0 })).data;
    expect(errors.find(error => error.rowNumber === 102)).toMatchObject({ column: reason === 'before-start' ? 'nextDueOn' : null });
    expect(errors.every(error => error.column !== null || reason !== 'before-start')).toBe(true);
    expect(errors.some(error => error.message.includes('chunk'))).toBe(false);
    const after = await read(); expect(after.memberships.find(row => row.id === family.later.id)).toEqual(family.later);
    expect(after.homes[0]!.billingDay).toBe(reason === 'before-start' ? 15 : 20);
  });
  it('refuses to rewrite a live monthly schedule omitted from the import, including a concurrent assignment', async () => {
    const f = await fixture(), other = await fixture('monthly', f.home.id);
    const batch = await analyzed([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' }]);
    await factory('memberships', gymId, { householdId: f.home.id, memberId: other.member.id, planId: other.plan.id,
      status: 'active', startsOn: '2026-10-20', nextDueOn: '2026-11-20' });
    const before = await read(); await expect(batch.commit()).rejects.toBeInstanceOf(RevisionConflictError); expect(await read()).toEqual(before);
    const checked = await analyzed([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' }]);
    expect(checked.planned[0]!.issues).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });
  it('requires plan IDs for duplicate catalog names and creates a new membership for a returning member', async () => {
    const f = await fixture(); await factory('plans', gymId, { name: f.plan.name });
    const ambiguous = await analyzed([{ email: f.member.email!, plan: f.plan.name, nextDueOn: '2026-11-15' }]);
    expect(ambiguous.planned[0]!.issues).toEqual([expect.objectContaining({ code: 'unknown_reference' })]);
    await (await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-15' }])).run();
    await database.forGym(gymId, tx => tx.update(memberships).set({ status: 'cancelled' }).where(eq(memberships.memberId, f.member.id)));
    const cancelled = (await read()).memberships[0]!;
    const source = await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-12-15' }], 'update');
    expect((await source.preview()).summary).toMatchObject({ create: 1, update: 0, errors: 0 });
    expect((await source.run()).committedRows).toBe(1);
    const after = (await read()).memberships;
    expect(after).toHaveLength(2); expect(after.find(row => row.id === cancelled.id)).toEqual(cancelled);
    expect(after.find(row => row.id !== cancelled.id)).toMatchObject({ status: 'active', nextDueOn: '2026-12-15' });
    expect((await (await services().load([{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-12-15' }], 'skip')).run()).committedRows).toBe(0);
    expect((await read()).memberships).toEqual(after);
  });
  it('never derives an anchor from an ambiguous identity in another chunk', async () => {
    const f = await fixture(); await factory('members', gymId, { email: f.member.email });
    const document = parseCsv(csv([
      { firstName: f.member.firstName, lastName: f.member.lastName, plan: f.plan.id, nextDueOn: '2026-11-15' },
      { email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-20' },
    ]));
    const context: MapperContext = { gymId, actor: { kind: 'system' }, clock, runId: uuidv7(), timezone: 'America/Vancouver', sourceRows: document.rows };
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'memberships', mapping: autoMatch(document.columns), duplicatePolicy: 'error' };
    const planned = await database.forGym(gymId, tx => membershipsMapper.analyze(tx, document.rows.slice(0, 1), plan, context));
    expect(planned[0]).toMatchObject({ action: 'create', values: { billingDay: 15 }, issues: [] });
  });
  it('reports a standalone currency mismatch as a row error', async () => {
    const f = await fixture(), source = await services().load([{ email: f.member.email!, plan: f.plan.id, currency: 'USD', nextDueOn: '2026-11-15' }]);
    expect((await source.preview()).summary.errors).toBe(1); expect((await source.run()).committedRows).toBe(0);
  });
  it('detects duplicate member aliases across chunk boundaries and resumes after losing a committed chunk acknowledgement', async () => {
    const f = await fixture('annual'), records: Cells[] = [];
    for (let i = 0; i < 101; i++) {
      const member = i === 0 ? f.member : await factory('members', gymId, { householdId: f.home.id, email: `private-${i}@example.test` });
      records.push({ email: member.email!, plan: f.plan.id, nextDueOn: '2027-06-15' });
    }
    records.push({ firstName: f.member.firstName, lastName: f.member.lastName, plan: f.plan.id, nextDueOn: '2027-06-15' });
    let crashed = false;
    const active: { runId?: string } = {};
    const scope: typeof forGym = async (gym, fn) => {
      if (crashed) throw new Error('worker stopped');
      const result = await database.forGym(gym, fn);
      if (active.runId) {
        const [run] = await database.forGym(gym, tx => tx.select().from(importRuns).where(eq(importRuns.id, active.runId!)));
        if (run?.processedRows === 100) { crashed = true; throw new Error('worker stopped'); }
      }
      return result;
    };
    const service = services(scope), source = await service.load(records, 'skip');
    expect((await source.preview()).summary).toMatchObject({ create: 101, errors: 1 });
    const job = await service.pipeline.start(source.actor, { ...source.plan, dryRun: false }, 'America/Vancouver'); active.runId = job.id;
    await expect(service.pipeline.run(gymId, job.id)).rejects.toThrow('worker stopped');
    expect((await read()).memberships).toHaveLength(100);
    const restarted = createImportPipeline({ scope: database.forGym, clock, jobs: new FakeJobs(clock), uploadsFor: service.uploadsFor });
    await Promise.all([restarted.run(gymId, job.id), restarted.run(gymId, job.id)]);
    expect(await restarted.get(gymId, job.id)).toMatchObject({ status: 'failed', processedRows: 102, committedRows: 101, errorCount: 1 });
    expect((await read()).memberships).toHaveLength(101);
    const chunks = await database.forGym(gymId, tx => tx.select().from(importChunks).where(eq(importChunks.runId, job.id)));
    expect(chunks).toHaveLength(2); expect(chunks.every(chunk => chunk.completedAt)).toBe(true);
    expect((await restarted.errors(gymId, job.id, { limit: 100, offset: 0 })).data).toEqual([expect.objectContaining({ rowNumber: 103, code: 'duplicate' })]);
  });
  it('rolls back a killed chunk and resumes with no partial memberships or audits', async () => {
    const f = await fixture(), records = [{ email: f.member.email!, plan: f.plan.id, nextDueOn: '2026-11-17' }];
    let stopped = false;
    const scope: typeof forGym = (gym, fn) => stopped ? Promise.reject(new Error('worker killed')) : database.forGym(gym, fn);
    const mapper = { ...membershipsMapper, async commit(...args: Parameters<typeof membershipsMapper.commit>) {
      await membershipsMapper.commit(...args); stopped = true; throw new Error('worker killed');
    } };
    const service = services(scope, new MapperRegistry([mapper])), source = await service.load(records);
    const job = await service.pipeline.start(source.actor, { ...source.plan, dryRun: false }, 'America/Vancouver');
    const before = await read(); await expect(service.pipeline.run(gymId, job.id)).rejects.toThrow('worker killed'); expect(await read()).toEqual(before);
    const restarted = createImportPipeline({ scope: database.forGym, clock, jobs: new FakeJobs(clock), uploadsFor: service.uploadsFor });
    await restarted.run(gymId, job.id); expect(await restarted.get(gymId, job.id)).toMatchObject({ status: 'succeeded', committedRows: 1 });
  });
});

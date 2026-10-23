// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, members, memberTags, memberTagLinks, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { autoMatch, csvLine, parseCsv } from '../pipeline.csv.js';
import { createImportPipeline } from '../pipeline.js';
import { peopleMapper } from './people.js';
import { familyExport, minimalExport } from './people.fixtures.js';
import type { MapperContext } from './registry.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
let gymA: string, gymB: string;
beforeEach(async () => {
  gymA = uuidv7(); gymB = uuidv7();
  await factory('gyms', gymA); await factory('gyms', gymB);
});
function services() {
  const stores = new Map<string, FakeUploads>(), jobs = new FakeJobs(clock);
  const pipeline = createImportPipeline({ scope: database.forGym, clock, jobs, uploadsFor: async (gymId) => {
    if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock));
    return stores.get(gymId)!;
  } });
  async function load(csv: string, options: Partial<ImportPlanRequest> = {}, gymId = gymA) {
    const actor = { gymId, actor: { kind: 'system' } } as const;
    const upload = await pipeline.upload(actor, new File([csv], 'members.csv'));
    const plan: ImportPlanRequest = { uploadId: upload.id, mapper: 'people', mapping: autoMatch(parseCsv(csv).columns), duplicatePolicy: 'error', ...options };
    return { actor, plan, preview: () => pipeline.preview(actor, plan, { limit: 100, offset: 0 }, 'UTC'),
      async run(dryRun = false) {
        const job = await pipeline.start(actor, { ...plan, dryRun }, 'UTC');
        await pipeline.run(gymId, job.id);
        return { job: await pipeline.get(gymId, job.id), issues: (await pipeline.errors(gymId, job.id, { limit: 100, offset: 0 })).data };
      } };
  }
  return { pipeline, load };
}
const snapshot = (gymId = gymA) => database.forGym(gymId, async (tx) => ({
  members: await tx.select().from(members), households: await tx.select().from(households),
  methods: await tx.select().from(paymentMethods), tags: await tx.select().from(memberTags),
  links: await tx.select().from(memberTagLinks), audits: await tx.select().from(auditEvents),
}));

describe('people mapper through the real import pipeline', () => {
  it('imports family exports, frozen status, opt-outs, tags and stored Stripe IDs; reimporting skips duplicates', async () => {
    const { load } = services(), source = await load(familyExport);
    expect((await source.preview()).summary).toEqual({ totalRows: 4, create: 4, update: 0, skip: 0, errors: 0 });
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 4 });
    const data = await snapshot(), ari = data.members.find((member) => member.firstName === 'Ari')!;
    expect(data.households).toHaveLength(2); expect(data.members).toHaveLength(4);
    expect(data.members.find((member) => member.firstName === 'Lea')).toMatchObject({ householdId: ari.householdId, status: 'frozen', emailOptOut: false });
    expect(ari).toMatchObject({ emailOptOut: true, phone: '555-0100', dateOfBirth: '1980-04-25' });
    expect(data.members.find((member) => member.firstName === 'Kai')).toMatchObject({ status: 'cancelled', emailOptOut: false });
    expect(data.households.find((home) => home.id === ari.householdId)).toMatchObject({ name: 'Stone household', billingDay: 15, stripeCustomerId: 'cus_Stone', pinHash: null });
    expect(data.methods).toHaveLength(2);
    expect(data.methods.find((method) => method.householdId === ari.householdId)).toMatchObject({ processorId: 'pm_Stone', isDefault: true, brand: null, last4: null });
    expect(data.tags.map((tag) => tag.name).sort()).toEqual(['Adults', 'Kids', 'Morning']); expect(data.links).toHaveLength(5);
    expect(data.audits.every((audit) => audit.occurredAt.toISOString() === clock.now().toISOString())).toBe(true);
    const auditData = JSON.stringify(data.audits.map((audit) => [audit.before, audit.after]));
    for (const pii of ['Ari', 'Stone', 'ari@example.test', '555-0100', '1980-04-25', 'pm_Stone', 'cus_Stone']) expect(auditData).not.toContain(pii);
    const repeated = await load(familyExport, { duplicatePolicy: 'skip' });
    expect((await repeated.preview()).summary.skip).toBe(4);
    expect((await repeated.run()).job).toMatchObject({ status: 'succeeded', committedRows: 0 });
    const after = await snapshot(); expect(after.members).toEqual(data.members); expect(after.households).toEqual(data.households); expect(after.methods).toEqual(data.methods);
  });
  it('preview and dry run leave domain rows and audits unchanged', async () => {
    const source = await services().load(familyExport), before = await snapshot();
    await source.preview(); expect(await snapshot()).toEqual(before);
    expect((await source.run(true)).job).toMatchObject({ status: 'succeeded', committedRows: 0 });
    expect(await snapshot()).toEqual(before);
  });
  it('flags existing duplicates by policy and updates with revisions without clearing unmapped details', async () => {
    const original = await factory('members', gymA, { firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test',
      phone: '555-keep', status: 'active', emailOptOut: true, medicalNotes: 'Keep private', revision: 7 });
    const { load } = services(), duplicate = await load(minimalExport);
    expect((await duplicate.preview()).summary.errors).toBe(1);
    const update = await load('First Name,Last Name,Email,Status\nJo,Fields,jo@example.test,Frozen\n', { duplicatePolicy: 'update' });
    expect((await update.preview()).summary.update).toBe(1);
    expect((await update.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
    const [member] = (await snapshot()).members;
    expect(member).toMatchObject({ id: original.id, householdId: original.householdId, status: 'frozen', revision: 8,
      phone: '555-keep', emailOptOut: true, medicalNotes: 'Keep private' });
  });
  it('flags within-file duplicates even across chunk boundaries and never creates a second copy', async () => {
    const csv = 'First Name,Last Name,Email\n' + Array.from({ length: 101 }, (_, i) =>
      `Person${i},Family${i},person${i}@example.test\n`).join('') + 'Person0,Family0,person0@example.test\n';
    const source = await services().load(csv, { duplicatePolicy: 'update' });
    expect((await source.preview()).summary).toMatchObject({ create: 101, errors: 1 });
    const result = await source.run();
    expect(result.job).toMatchObject({ status: 'failed', committedRows: 101, processedRows: 102 });
    expect(result.issues).toEqual([expect.objectContaining({ rowNumber: 103, code: 'duplicate' })]);
    expect((await snapshot()).members).toHaveLength(101);
  });
  it('keeps a family together when its members span chunks and the payer row comes last', async () => {
    const csv = 'Member ID,First Name,Last Name,Household External ID,Stripe Customer ID,Stripe Payment Method ID\n'
      + Array.from({ length: 101 }, (_, i) => `child${i},Child${i},Family,payer,,\n`).join('')
      + 'payer,Payer,Family,,cus_Family,pm_Family\n';
    const result = await (await services().load(csv)).run();
    expect(result.job).toMatchObject({ status: 'succeeded', committedRows: 102 });
    const data = await snapshot();
    expect(data.households).toHaveLength(1); expect(new Set(data.members.map((member) => member.householdId)).size).toBe(1);
    expect(data.methods).toHaveLength(1); expect(data.households[0]).toMatchObject({ stripeCustomerId: 'cus_Family' });
  });
  it('groups a shared customer despite distinct member IDs and keeps customer IDs case-sensitive', async () => {
    const source = await services().load('Member ID,First Name,Last Name,Stripe Customer ID\n1,One,Family,cus_Abc\n2,Two,Family,cus_Abc\n3,Three,Family,cus_abc\n');
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 3 });
    const data = await snapshot(); expect(data.households).toHaveLength(2);
    expect(data.members[0]!.householdId).toBe(data.members[1]!.householdId);
    expect(data.members[2]!.householdId).not.toBe(data.members[0]!.householdId);
  });
  it('attaches a new relative to a matched family even when the existing member is skipped', async () => {
    const parent = await factory('members', gymA, { firstName: 'Jo', lastName: 'Fields' });
    const csv = 'Member ID,First Name,Last Name,Email,Household External ID\nparent,Jo,Fields,jo@example.test,\nchild,Lee,Fields,,parent\n';
    const source = await services().load(csv, { duplicatePolicy: 'skip' });
    expect((await source.preview()).summary).toMatchObject({ skip: 1, create: 1, errors: 0 });
    expect((await source.run()).job.committedRows).toBe(1);
    const data = await snapshot(); expect(data.households).toHaveLength(1);
    expect(data.members.find((member) => member.firstName === 'Lee')!.householdId).toBe(parent.householdId);
  });
  it('never matches another gym, even when names, emails and processor IDs are identical', async () => {
    const { load } = services();
    await (await load(familyExport, {}, gymB)).run(); const before = await snapshot(gymB);
    expect((await (await load(familyExport)).preview()).summary.create).toBe(4);
    expect((await (await load(familyExport)).run()).job).toMatchObject({ status: 'succeeded', committedRows: 4 });
    expect(await snapshot(gymB)).toEqual(before);
    const data = await snapshot();
    expect(data.members.some((member) => before.members.some((other) => other.id === member.id || other.householdId === member.householdId))).toBe(false);
  });
  it('does not overwrite a saved customer or borrow a payment method from another household', async () => {
    const member = await factory('members', gymA, { firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test' });
    const other = await factory('households', gymA, { stripeCustomerId: 'cus_Other' });
    await factory('paymentMethods', gymA, { householdId: other.id, processorId: 'pm_Other' });
    const csv = 'First Name,Last Name,Email,Stripe Customer ID,Stripe Payment Method ID\nJo,Fields,jo@example.test,cus_Other,pm_Other\n';
    const source = await services().load(csv, { duplicatePolicy: 'update' }), before = await snapshot();
    expect((await source.preview()).summary.errors).toBe(1);
    const result = await source.run(); expect(result.job.committedRows).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toContain('conflict');
    expect((await snapshot()).members).toEqual(before.members);
    expect((await snapshot()).members[0]!.householdId).toBe(member.householdId);
    expect((await snapshot()).methods).toEqual(before.methods);
  });
  it('rejects ambiguous family matches instead of moving people or attaching a child arbitrarily', async () => {
    await factory('members', gymA, { firstName: 'One', lastName: 'Family', email: 'one@example.test' });
    await factory('members', gymA, { firstName: 'Two', lastName: 'Family', email: 'two@example.test' });
    const source = await services().load('First Name,Last Name,Email,Household External ID\nOne,Family,one@example.test,family\nTwo,Family,two@example.test,family\nChild,Family,,family\n', { duplicatePolicy: 'update' });
    expect((await source.preview()).summary.errors).toBe(3);
    expect((await source.run()).job.committedRows).toBe(0); expect((await snapshot()).members).toHaveLength(2);
  });
  it('marks invalid rows as errors in preview and still imports valid rows', async () => {
    const source = await services().load('First Name,Last Name,Email,Status\nJo,Fields,invalid,unknown\nValid,Person,valid@example.test,Active\n');
    expect((await source.preview()).summary).toMatchObject({ errors: 1, create: 1 });
    expect((await source.run()).job).toMatchObject({ committedRows: 1, status: 'failed' });
    expect((await snapshot()).members[0]).toMatchObject({ firstName: 'Valid', status: 'active' });
  });
  it('ignores unmapped PINs and medical notes and rejects attempts to map medical notes', async () => {
    const csv = 'First Name,Last Name,PIN,Medical Notes\nJo,Fields,1234,private diagnosis\n';
    const { load } = services(), mapping: ImportPlanRequest['mapping'] = [
      { sourceColumn: 'First Name', targetField: 'firstName' }, { sourceColumn: 'Last Name', targetField: 'lastName' },
    ];
    expect((await (await load(csv, { mapping })).run()).job.committedRows).toBe(1);
    const data = await snapshot(); expect(data.members[0]!.medicalNotes).toBeNull(); expect(data.households[0]!.pinHash).toBeNull();
    expect((await (await load(csv)).preview()).summary.errors).toBe(1);
  });
  it('retains an existing default payment method and never revives a revoked one', async () => {
    const home = await factory('households', gymA, { stripeCustomerId: 'cus_Saved' });
    const member = await factory('members', gymA, { householdId: home.id, firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test' });
    await factory('paymentMethods', gymA, { householdId: home.id, processorId: 'pm_Default', isDefault: true });
    const revoked = await factory('paymentMethods', gymA, { householdId: home.id, processorId: 'pm_Revoked', revokedAt: clock.now() });
    const { load } = services();
    const csv = 'First Name,Last Name,Email,Stripe Customer ID,Stripe Payment Method ID\nJo,Fields,jo@example.test,cus_Saved,pm_New\n';
    await (await load(csv, { duplicatePolicy: 'update' })).run();
    await (await load(csv.replace('pm_New', 'pm_Revoked'), { duplicatePolicy: 'update' })).run();
    const data = await snapshot(); expect(data.methods).toHaveLength(3);
    expect(data.methods.find((method) => method.processorId === 'pm_Default')!.isDefault).toBe(true);
    expect(data.methods.find((method) => method.processorId === 'pm_New')!.isDefault).toBe(false);
    expect(data.methods.find((method) => method.id === revoked.id)!.revokedAt).toEqual(clock.now());
    expect(data.members[0]!.id).toBe(member.id);
  });
  it('uses date evidence outside the current chunk and reports same-name ambiguity under update policy', async () => {
    await factory('members', gymA, { firstName: 'Same', lastName: 'Name', email: 'same@example.test' });
    await factory('members', gymA, { firstName: 'Same', lastName: 'Name', email: 'same@example.test' });
    const source = await services().load('First Name,Last Name,Email\nSame,Name,same@example.test\n', { duplicatePolicy: 'update' });
    expect((await source.preview()).summary.errors).toBe(1);
    expect((await source.run()).job.committedRows).toBe(0);
    const rows = parseCsv('First Name,Last Name,Date of Birth\nOne,Date,05/06/2014\nTwo,Date,25/04/2012\n').rows;
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'error', mapping: autoMatch(Object.keys(rows[0]!.values)) };
    const context: MapperContext = { gymId: gymA, actor: { kind: 'system' }, runId: uuidv7(), clock, timezone: 'UTC', sourceRows: rows };
    const [first] = await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, rows.slice(0, 1), plan, context));
    expect(first!.values.dateOfBirth).toBe('2014-06-05'); expect(first!.issues).toEqual([]);
  });
  it('does not match anonymized members and escapes SQL wildcard characters in names', async () => {
    await factory('members', gymA, { firstName: 'Erased', lastName: 'Person', anonymizedAt: clock.now() });
    await factory('members', gymA, { firstName: 'Jo', lastName: 'AnyName' });
    const source = await services().load('First Name,Last Name\nErased,Person\nJo,%\n');
    expect((await source.preview()).summary).toMatchObject({ create: 2, errors: 0 });
    expect((await source.run()).job.committedRows).toBe(2);
  });
  it('rechecks payment ownership at commit and rolls back domain writes when it changed', async () => {
    const rows = parseCsv('First Name,Last Name,Stripe Customer ID,Stripe Payment Method ID\nJo,Fields,cus_New,pm_Race\n').rows;
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'error', mapping: autoMatch(Object.keys(rows[0]!.values)) };
    const context: MapperContext = { gymId: gymA, actor: { kind: 'system' }, runId: uuidv7(), clock, timezone: 'UTC', sourceRows: rows };
    const planned = await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, rows, plan, context));
    const other = await factory('households', gymA);
    await factory('paymentMethods', gymA, { householdId: other.id, processorId: 'pm_Race' });
    const before = await snapshot();
    await expect(database.forGym(gymA, (tx) => peopleMapper.commit(tx, planned, context))).rejects.toThrow('another household');
    expect(await snapshot()).toEqual(before);
  });
  it('audits household billing-day updates and preserves existing default settings for blank cells', async () => {
    const home = await factory('households', gymA, { name: 'Existing', billingDay: 9, revision: 4 });
    await factory('members', gymA, { householdId: home.id, firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test' });
    const source = await services().load('First Name,Last Name,Email,Billing Day\nJo,Fields,jo@example.test,12\n', { duplicatePolicy: 'update' });
    await source.run();
    const [updated] = await database.forGym(gymA, (tx) => tx.select().from(households).where(eq(households.id, home.id)));
    expect(updated).toMatchObject({ billingDay: 12, revision: 5, name: 'Existing' });
    expect((await snapshot()).audits).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'household.updated', targetId: home.id })]));
  });
  it('keeps explicit households separate and flags reused payment IDs within the file', async () => {
    const csv = csvLine(['First Name', 'Last Name', 'Household External ID', 'Stripe Customer ID', 'Stripe Payment Method ID'])
      + csvLine(['One', 'Family', 'one', 'cus_One', 'pm_Same']) + csvLine(['Two', 'Family', 'two', 'cus_Two', 'pm_Same']);
    const source = await services().load(csv);
    expect((await source.preview()).summary).toMatchObject({ create: 1, errors: 1 });
    const result = await source.run(); expect(result.job.committedRows).toBe(1);
    expect(result.issues).toEqual([expect.objectContaining({ code: 'conflict' })]);
  });
  it('rejects a different customer on an existing household and payment methods without a customer', async () => {
    const home = await factory('households', gymA, { stripeCustomerId: 'cus_Original' });
    await factory('members', gymA, { householdId: home.id, firstName: 'Jo', lastName: 'Fields', email: 'jo@example.test' });
    const { load } = services();
    const source = await load('First Name,Last Name,Email,Stripe Customer ID\nJo,Fields,jo@example.test,cus_Changed\n', { duplicatePolicy: 'update' });
    expect((await source.preview()).summary.errors).toBe(1);
    expect((await source.run()).job.committedRows).toBe(0);
    const orphan = await load('First Name,Last Name,Stripe Payment Method ID\nNew,Person,pm_Orphan\n');
    expect((await orphan.run()).issues).toEqual([expect.objectContaining({ code: 'missing_required' })]);
    const data = await snapshot(); expect(data.methods).toHaveLength(0); expect(data.households[0]!.stripeCustomerId).toBe('cus_Original');
  });
});

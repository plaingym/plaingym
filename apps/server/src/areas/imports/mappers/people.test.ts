// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { auditEvents, households, members, memberTags, memberTagLinks, paymentMethods, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../../core/clock.js';
import { FakeJobs } from '../../../infra/jobs/index.js';
import { FakePayments } from '../../../infra/payments/index.js';
import { StripeFixtures } from '../../../infra/payments/stripe-fixtures.js';
import { StripePayments } from '../../../infra/payments/stripe.js';
import { FakeUploads } from '../../../infra/storage/index.js';
import { createSettingsService } from '../../settings/settings.js';
import { autoMatch, csvLine, parseCsv } from '../pipeline.csv.js';
import { createImportPipeline } from '../pipeline.js';
import { createPeopleMapper, peopleMapper } from './people.js';
import { familyExport, minimalExport } from './people.fixtures.js';
import type { MapperContext } from './registry.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z');
let gymA: string, gymB: string;
beforeEach(async () => {
  gymA = uuidv7(); gymB = uuidv7();
  await factory('gyms', gymA, { address: { country: 'GB' } }); await factory('gyms', gymB, { address: { country: 'GB' } });
});
function services(paymentsFor?: NonNullable<Parameters<typeof createImportPipeline>[0]['paymentsFor']>) {
  const stores = new Map<string, FakeUploads>(), jobs = new FakeJobs(clock);
  const pipeline = createImportPipeline({ scope: database.forGym, clock, jobs, ...(paymentsFor ? { paymentsFor } : {}), uploadsFor: async (gymId) => {
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

async function familyPayments(gymId: string) {
  const provider = new FakePayments(gymId, clock);
  for (const customer of ['Stone', 'River']) {
    provider.recordPaymentMethod({ id: 'pm_' + customer, customerId: 'cus_' + customer, type: 'card',
      last4: '4242', expiresMonth: 12, expiresYear: 2035 });
  }
  return provider;
}

it.each(['McCASE', 'A_%\\B', 'Émile', 'İpek', 'Σίγμα'])('keeps duplicate matching and isolation for %s', async (lastName) => {
  const own = await factory('members', gymA, { firstName: 'Jo', lastName, email: 'jo@example.test' });
  await factory('members', gymB, { firstName: 'Jo', lastName, email: 'jo@example.test' });
  await factory('members', gymA, { firstName: 'Jo', lastName, email: 'jo@example.test', anonymizedAt: clock.now() });
  const { load } = services();
  const input = await load(csvLine(['First Name', 'Last Name', 'Email']) + csvLine(['Jo', lastName, 'jo@example.test']));
  expect((await input.preview()).data[0]!.duplicateIds).toEqual([own.id]);
});
const snapshot = (gymId = gymA) => database.forGym(gymId, async (tx) => ({
  // Postgres returns unordered rows in any order, so compare in ID order.
  members: await tx.select().from(members).orderBy(asc(members.id)), households: await tx.select().from(households).orderBy(asc(households.id)),
  methods: await tx.select().from(paymentMethods).orderBy(asc(paymentMethods.id)), tags: await tx.select().from(memberTags).orderBy(asc(memberTags.id)),
  links: await tx.select().from(memberTagLinks).orderBy(asc(memberTagLinks.id)), audits: await tx.select().from(auditEvents).orderBy(asc(auditEvents.id)),
}));

it.each([
  ['USD', 'us_bank_account', 'acss_debit'],
  ['CAD', 'acss_debit', 'us_bank_account'],
] as const)('validates Stripe bank accounts against %s in the dry run and commit', async (currency, type, otherType) => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency, bankDebitsEnabled: false });
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_Match', email: 'match@example.test', gymId: null });
  provider.seedCustomer({ id: 'cus_Other', email: 'other@example.test', gymId: null });
  provider.seedCustomer({ id: 'cus_Foreign', email: 'foreign@example.test', gymId: null });
  provider.recordPaymentMethod({ id: 'pm_Match', customerId: 'cus_Match', type, bankName: 'Test bank', last4: '1234' });
  provider.recordPaymentMethod({ id: 'pm_WrongCurrency', customerId: 'cus_Other', type: otherType, last4: '4321' });
  provider.recordPaymentMethod({ id: 'pm_WrongCustomer', customerId: 'cus_Match', type, last4: '4321' });
  const mandateId = type === 'acss_debit' ? 'mandate_csv' : null;
  if (mandateId) provider.recordSetup({ id: 'seti_csv', customerId: 'cus_Match', paymentMethodId: 'pm_Match',
    status: 'succeeded', mandateId, metadata: { gymId } });
  const reference = { kind: 'payment_method', id: 'pm_Match' } as const;
  expect(await provider.readPaymentObject(reference)).toEqual({ status: 'unknown', reference });
  const { load } = services(async id => id === gymId ? provider : null);
  const csv = csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_Match', 'pm_Match']) + csvLine(['Second', 'Family', 'cus_Other', 'pm_WrongCurrency'])
    + csvLine(['Third', 'Family', 'cus_Foreign', 'pm_WrongCustomer']);
  const input = await load(csv, { duplicatePolicy: 'skip' }, gymId);
  expect((await input.preview()).data.map(row => row.action)).toEqual(['create', 'create', 'create']);
  const wrongCurrency = { column: 'Stripe Payment Method ID', code: 'invalid_value', message: `This bank account can't be charged in ${currency}.` };
  const wrongCustomer = { column: 'Stripe Payment Method ID', code: 'conflict', message: 'This bank account belongs to a different Stripe customer.' };
  expect((await input.run(true)).issues).toMatchObject([wrongCurrency, wrongCustomer]);
  expect((await snapshot(gymId)).methods).toHaveLength(0);
  const committed = await input.run();
  expect(committed.job).toMatchObject({ committedRows: 1, errorCount: 2 });
  expect(committed.issues).toMatchObject([wrongCurrency, wrongCustomer]);
  const saved = (await snapshot(gymId)).methods;
  expect(saved).toMatchObject([{ processorId: 'pm_Match', type, bankName: 'Test bank',
    last4: '1234', expiryMonth: null, expiryYear: null, mandateId, isDefault: true }]);
  expect((await input.run()).job.committedRows).toBe(0);
  const settings = createSettingsService({ scope: database.forGym, clock });
  await settings.update(input.actor, 'currency', { revision: (await settings.get(gymId)).revision, currency: currency === 'USD' ? 'CAD' : 'USD' });
  const savedRow = await load(csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_Match', 'pm_Match']), { duplicatePolicy: 'skip' }, gymId);
  const rerun = await savedRow.run();
  expect(rerun.job.committedRows).toBe(0);
  expect(rerun.issues).toEqual([]);
  expect((await snapshot(gymId)).methods).toEqual(saved);
});

it('reports a Canadian bank account with no mandate and imports the card in its household', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD' });
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_Family', email: 'family@example.test', gymId: null });
  provider.recordPaymentMethod({ id: 'pm_Unmandated', customerId: 'cus_Family', type: 'acss_debit', last4: '1234' });
  const { load } = services(async () => provider);
  const csv = csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_Family', 'pm_Unmandated']) + csvLine(['Second', 'Family', 'cus_Family', 'pm_Card']);
  const input = await load(csv, {}, gymId);
  const expected = { column: 'Stripe Payment Method ID', code: 'invalid_value', message: 'This Canadian bank account needs a reusable Stripe mandate.' };
  expect((await input.preview()).data.map(row => row.action)).toEqual(['create', 'create']);
  expect((await input.run(true)).issues).toMatchObject([expected]);
  expect((await input.run()).issues).toMatchObject([expected]);
  expect((await snapshot(gymId)).methods).toMatchObject([{ type: 'card', processorId: 'pm_Card', isDefault: true }]);
});

it.each([{ statusCode: 403 }, { rawType: 'permission_error' }])('reports a denied mandate read (%j) on the Canadian bank account row and imports the card', async failure => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'CAD' });
  const customer = 'cus_Family', bankId = 'pm_Pad', mandateId = 'mandate_pad';
  const stripe = new StripeFixtures(gymId);
  stripe.objects.set(customer, { id: customer, object: 'customer', metadata: {} });
  stripe.objects.set(bankId, { id: bankId, object: 'payment_method', customer, created: stripe.now,
    type: 'acss_debit', acss_debit: { last4: '1234' } });
  stripe.objects.set('seti_pad', { id: 'seti_pad', object: 'setup_intent', customer, payment_method: bankId,
    status: 'succeeded', usage: 'off_session', mandate: mandateId });
  const provider = new StripePayments(gymId, { webhookSecret: 'fixture-signing-secret', transport: {
    async request(input) {
      if (input.path === '/v1/mandates/' + mandateId) throw Object.assign(new Error('Forbidden'), failure);
      return stripe.request(input);
    },
  } });
  const { load } = services(async () => provider);
  const input = await load(csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', customer, bankId]) + csvLine(['Second', 'Family', customer, 'pm_Card']), {}, gymId);
  expect((await input.preview()).data.map(row => row.action)).toEqual(['create', 'create']);
  const expected = [{ rowNumber: 2, column: 'Stripe Payment Method ID',
    message: 'Give the Stripe key Mandates read access to import this Canadian bank account.' }];
  expect((await input.run(true)).issues).toMatchObject(expected);
  const result = await input.run();
  expect(result.job).toMatchObject({ status: 'failed', processedRows: 2, committedRows: 1, errorCount: 1 });
  expect(result.issues).toMatchObject(expected);
  expect((await snapshot(gymId)).methods).toMatchObject([{ type: 'card', processorId: 'pm_Card', isDefault: true }]);
});

it('shows a Stripe lookup failure in the dry run and imports other rows with and without payment methods', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'USD' });
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_Family', email: 'family@example.test', gymId: null });
  provider.recordPaymentMethod({ id: 'pm_Bank', customerId: 'cus_Family', type: 'us_bank_account', last4: '1234' });
  const read = provider.readBankAccountForImport.bind(provider);
  const lookup = vi.spyOn(provider, 'readBankAccountForImport').mockImplementation(async (id, includeMandate) => {
    if (id === 'pm_Failure') throw new Error('Stripe unavailable');
    return read(id, includeMandate);
  });
  const { load } = services(async () => provider);
  const input = await load(csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_Family', 'pm_Failure']) + csvLine(['Second', 'Family', 'cus_Family', 'pm_Bank'])
    + csvLine(['Third', 'Person', '', '']), {}, gymId);
  const preview = await input.preview();
  expect(preview.summary).toMatchObject({ errors: 0, create: 3 });
  expect(preview.data.map(row => row.action)).toEqual(['create', 'create', 'create']);
  expect(lookup).not.toHaveBeenCalled();
  const expected = [{ rowNumber: 2, column: 'Stripe Payment Method ID',
    message: "Stripe couldn't check this payment method. Try again later." }];
  expect((await input.run(true)).issues).toMatchObject(expected);
  expect(lookup.mock.calls).toEqual([['pm_Failure', false], ['pm_Bank', false]]);
  lookup.mockClear();
  const result = await input.run();
  expect(lookup.mock.calls).toEqual([['pm_Failure', false], ['pm_Bank', false]]);
  expect(result.job).toMatchObject({ status: 'failed', processedRows: 3, committedRows: 2, errorCount: 1 });
  expect(result.issues).toMatchObject(expected);
  const { members, methods } = await snapshot(gymId);
  expect(members.map(member => member.firstName)).toEqual(['Second', 'Third']);
  expect(methods).toMatchObject([{ type: 'us_bank_account', processorId: 'pm_Bank', isDefault: true }]);
});

it.each([
  { connection: 'no resolver', paymentsFor: undefined },
  { connection: 'a resolver with no provider', paymentsFor: async () => null },
])('rejects a new pm_ ID with $connection and imports the other row', async ({ paymentsFor }) => {
  const csv = csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_X', 'pm_New']) + csvLine(['Second', 'Person', '', '']);
  const input = await services(paymentsFor).load(csv);
  expect((await input.preview()).data).toMatchObject([{ rowNumber: 2, action: 'error' }, { rowNumber: 3, action: 'create' }]);
  const expected = [{ rowNumber: 2, column: 'Stripe Payment Method ID', code: 'invalid_value',
    message: 'Connect Stripe before importing this payment method ID, or leave the payment method column unmapped.' }];
  const mapper = createPeopleMapper(database.forGym, paymentsFor), { rows } = parseCsv(csv);
  const prepared = await mapper.prepare!(rows, input.plan,
    { ...input.actor, clock, runId: uuidv7(), timezone: 'UTC', sourceRows: rows, preview: true });
  const planned = await database.forGym(gymA, tx => mapper.analyze(tx, rows, input.plan, prepared));
  expect(planned.flatMap(row => row.issues)).toEqual(expected);

  expect((await input.run(true)).issues).toEqual(expected);
  const result = await input.run();
  expect(result.issues).toEqual(expected);
  expect(result.job).toMatchObject({ committedRows: 1, errorCount: 1 });
  const saved = await snapshot();
  expect(saved.members).toMatchObject([{ firstName: 'Second' }]);
  expect(saved.methods).toEqual([]);
});

it.each(['card_Old', 'ba_Old', 'src_Old'])('imports %s without a Stripe connection', async id => {
  const input = await services().load(csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_X', id]));
  expect((await input.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
  expect((await snapshot()).methods).toMatchObject([{ processorId: id, type: 'card', isDefault: true, last4: null }]);
});

it('retries preparation when gym settings change and commits the unaffected rows', async () => {
  const gymId = uuidv7();
  await factory('gyms', gymId, { currency: 'USD' });
  const provider = new FakePayments(gymId, clock);
  provider.seedCustomer({ id: 'cus_Family', email: 'family@example.test', gymId: null });
  provider.recordPaymentMethod({ id: 'pm_Bank', customerId: 'cus_Family', type: 'us_bank_account', last4: '1234' });
  const { load, pipeline } = services(async () => provider);
  const csv = csvLine(['First Name', 'Last Name', 'Stripe Customer ID', 'Stripe Payment Method ID'])
    + csvLine(['First', 'Family', 'cus_Family', 'pm_Bank']) + csvLine(['Second', 'Person', '', '']);
  const { actor, plan } = await load(csv, {}, gymId);
  const job = await pipeline.start(actor, { ...plan, dryRun: false }, 'UTC');
  const settings = createSettingsService({ scope: database.forGym, clock }), original = provider.readBankAccountForImport.bind(provider);
  vi.spyOn(provider, 'readBankAccountForImport').mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    await settings.update(actor, 'currency', { revision: (await settings.get(gymId)).revision, currency: 'CAD' });
    return result;
  });
  await expect(pipeline.run(gymId, job.id)).rejects.toThrow('Gym settings changed');
  expect(await pipeline.get(gymId, job.id)).toMatchObject({ processedRows: 0, committedRows: 0, errorCount: 0 });
  await pipeline.run(gymId, job.id, 2);
  expect(await pipeline.get(gymId, job.id)).toMatchObject({ processedRows: 2, committedRows: 1, errorCount: 1 });
  expect((await pipeline.errors(gymId, job.id, { limit: 100, offset: 0 })).data)
    .toMatchObject([{ message: "This bank account can't be charged in CAD." }]);
  expect((await snapshot(gymId)).members).toMatchObject([{ firstName: 'Second' }]);
});

async function consentedContacts(gymId = gymA) {
  const consent = { phone: '020 7946 0018', phoneE164: '+442079460018',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' };
  const home = await factory('households', gymId, { ...consent, revision: 4 });
  const member = await factory('members', gymId, { ...consent, householdId: home.id, firstName: 'Jo', lastName: 'Fields',
    email: 'jo@example.test', smsAnnouncementsConsentAt: clock.now(), smsAnnouncementsConsentSource: 'join', revision: 7 });
  return { home, member };
}

describe('people mapper through the real import pipeline', () => {
  it('rebuilds customer-keyed singleton families without merging their distinct member IDs', async () => {
    const input = await services().load(csvLine(['Member ID', 'First Name', 'Last Name', 'Email', 'Stripe Customer ID'])
      + Array.from({ length: 103 }, (_, i) => csvLine([`member${i}`, `Person${i}`, 'Family', `person${i}@example.test`, `cus_Solo${i}`])).join(''));
    const preview = await input.preview();
    expect(preview.summary).toMatchObject({ totalRows: 103, create: 103, errors: 0 });
    expect(preview.data[0]!.values).toMatchObject({ familyKey: JSON.stringify(['customer', 'cus_Solo0']), householdName: 'Person0 Family' });
    expect((await input.run()).job).toMatchObject({ status: 'succeeded', committedRows: 103 });
    const saved = await snapshot();
    expect(saved.households).toHaveLength(103);
    expect(new Set(saved.members.map(person => person.householdId)).size).toBe(103);
    expect(new Set(saved.households.map(home => home.stripeCustomerId)).size).toBe(103);
  });
  it('imports family exports, frozen status, opt-outs, tags and stored Stripe IDs; reimporting skips duplicates', async () => {
    const { load } = services(familyPayments), source = await load(familyExport);
    expect((await source.preview()).summary).toEqual({ totalRows: 4, create: 4, update: 0, skip: 0, errors: 0 });
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 4 });
    const data = await snapshot(), ari = data.members.find((member) => member.firstName === 'Ari')!;
    expect(data.households).toHaveLength(2); expect(data.members).toHaveLength(4);
    expect(data.members.find((member) => member.firstName === 'Lea')).toMatchObject({ householdId: ari.householdId, status: 'frozen', emailOptOut: false });
    expect(ari).toMatchObject({ emailOptOut: true, phone: '555-0100', dateOfBirth: '1980-04-25' });
    expect(data.members.find((member) => member.firstName === 'Kai')).toMatchObject({ status: 'cancelled', emailOptOut: false });
    expect(data.households.find((home) => home.id === ari.householdId)).toMatchObject({ name: 'Stone household', billingDay: 15, stripeCustomerId: 'cus_Stone', pinHash: null });
    expect(data.methods).toHaveLength(2);
    expect(data.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ householdId: ari.householdId, processorId: 'pm_Stone', type: 'card', isDefault: true, brand: null, last4: null }),
      expect.objectContaining({ processorId: 'pm_River', type: 'card', isDefault: true, brand: null, last4: null }),
    ]));
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
    const source = await services(familyPayments).load(familyExport), before = await snapshot();
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
  it.each([
    { phone: '020 7946 0019', normalized: '+442079460019' },
    { phone: 'not a phone', normalized: null },
  ])('clears and audits member SMS consent, keeping the household billing phone, when importing $phone', async ({ phone, normalized }) => {
    const { home, member } = await consentedContacts();
    await consentedContacts(gymB);
    const otherGym = await snapshot(gymB);
    const { load } = services();
    const source = await load(csvLine(['First Name', 'Last Name', 'Email', 'Phone'])
      + csvLine(['Jo', 'Fields', 'jo@example.test', phone]), { duplicatePolicy: 'update' });
    const before = await snapshot();
    await source.preview();
    expect((await source.run(true)).job).toMatchObject({ status: 'succeeded', committedRows: 0 });
    expect(await snapshot()).toEqual(before);
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
    const saved = await snapshot();
    expect(saved.members[0]).toMatchObject({ id: member.id, phone, phoneE164: normalized, revision: 8,
      smsNoticesConsentAt: null, smsNoticesConsentSource: null, smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null });
    // The household billing phone and its consent are not the member's: an import never changes them.
    expect(saved.households).toEqual(before.households);
    expect(saved.households[0]).toMatchObject({ id: home.id, phone: '020 7946 0018', smsNoticesConsentAt: clock.now() });
    const audits = saved.audits.filter((event) => event.action.endsWith('.sms_consent_changed'));
    expect(audits).toHaveLength(2);
    for (const [targetType, targetId, kind, consentSource] of [
      ['member', member.id, 'notices', 'portal'], ['member', member.id, 'announcements', 'join'],
    ]) expect(audits).toContainEqual(expect.objectContaining({ gymId: gymA, actorKind: 'system', targetType, targetId,
      action: targetType + '.sms_consent_changed', occurredAt: clock.now(),
      before: { kind, at: clock.now().toISOString(), source: consentSource },
      after: { kind, at: null, source: null, changeSource: 'staff' } }));
    const auditData = JSON.stringify(saved.audits.map((event) => [event.before, event.after]));
    for (const value of [phone, '020 7946 0018', '+442079460018', normalized].filter((value) => value !== null)) expect(auditData).not.toContain(value);
    // Returning to the previously consented number cannot revive its consent.
    await (await load('First Name,Last Name,Email,Phone\nJo,Fields,jo@example.test,020 7946 0018\n', { duplicatePolicy: 'update' })).run();
    const restored = await snapshot();
    expect(restored.members[0]).toMatchObject({ phoneE164: '+442079460018', smsNoticesConsentAt: null, smsAnnouncementsConsentAt: null });
    expect(restored.households).toEqual(before.households);
    expect(restored.audits.filter((event) => event.action.endsWith('.sms_consent_changed'))).toHaveLength(2);
    expect(await snapshot(gymB)).toEqual(otherGym);
  });
  it.each(['020 7946 0018', '02079460018', '+44 (20) 7946 0018', '', null])('keeps SMS consent for an unchanged, reformatted or absent phone: %s', async (phone) => {
    const { home, member } = await consentedContacts();
    // csvLine protects exported '+' cells with an apostrophe; this fixture models an unmodified incoming phone.
    const csv = csvLine(['First Name', 'Last Name', 'Email', ...(phone === null ? [] : ['Phone'])])
      + (phone?.startsWith('+') ? `Jo,Fields,jo@example.test,"${phone}"\n`
        : csvLine(['Jo', 'Fields', 'jo@example.test', ...(phone === null ? [] : [phone])]));
    const source = await services().load(csv, { duplicatePolicy: 'update' });
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
    const saved = await snapshot(), expectedPhone = phone || member.phone;
    expect(saved.members[0]).toMatchObject({ phone: expectedPhone, phoneE164: member.phoneE164,
      smsNoticesConsentAt: member.smsNoticesConsentAt, smsNoticesConsentSource: member.smsNoticesConsentSource,
      smsAnnouncementsConsentAt: member.smsAnnouncementsConsentAt, smsAnnouncementsConsentSource: member.smsAnnouncementsConsentSource });
    expect(saved.households[0]).toMatchObject({ phone: home.phone, phoneE164: home.phoneE164, revision: home.revision,
      smsNoticesConsentAt: home.smsNoticesConsentAt, smsNoticesConsentSource: home.smsNoticesConsentSource });
    expect(saved.audits.filter((event) => event.action.endsWith('.sms_consent_changed'))).toEqual([]);
  });
  it('rolls back phone and consent changes and their audits if a later import write fails', async () => {
    await consentedContacts();
    const rows = parseCsv('First Name,Last Name,Email,Phone,Stripe Customer ID,Stripe Payment Method ID\nJo,Fields,jo@example.test,020 7946 0019,cus_New,pm_Race\n').rows;
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'update', mapping: autoMatch(Object.keys(rows[0]!.values)) };
    const context: MapperContext = { gymId: gymA, actor: { kind: 'system' }, runId: uuidv7(), clock, timezone: 'UTC', sourceRows: rows };
    const planned = await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, rows, plan, context));
    expect(planned[0]!.issues).toEqual([]);
    const other = await factory('households', gymA);
    await factory('paymentMethods', gymA, { householdId: other.id, processorId: 'pm_Race' });
    const before = await snapshot();
    await expect(database.forGym(gymA, (tx) => peopleMapper.commit(tx, planned.map((row) => ({ ...row, action: 'update' })), context)))
      .rejects.toThrow('Payment method belongs to another household');
    expect(await snapshot()).toEqual(before);
  });
  it('does not revive stale consent when reformatting a phone whose stored consent number differs', async () => {
    const { member, home } = await consentedContacts();
    await database.forGym(gymA, async (tx) => {
      await tx.update(members).set({ phoneE164: '+442079460019' }).where(eq(members.id, member.id));
      await tx.update(households).set({ phoneE164: '+442079460019' }).where(eq(households.id, home.id));
    });
    const source = await services().load('First Name,Last Name,Email,Phone\nJo,Fields,jo@example.test,02079460018\n', { duplicatePolicy: 'update' });
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
    const saved = await snapshot();
    expect(saved.members[0]).toMatchObject({ phoneE164: '+442079460018', smsNoticesConsentAt: null, smsNoticesConsentSource: null,
      smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null });
    expect(saved.households[0]).toMatchObject({ phoneE164: '+442079460019', smsNoticesConsentAt: home.smsNoticesConsentAt,
      smsNoticesConsentSource: home.smsNoticesConsentSource });
    expect(saved.audits.filter((event) => event.action.endsWith('.sms_consent_changed'))).toHaveLength(2);
  });
  it('stores normalized phones for created members and households, without SMS consent', async () => {
    const source = await services().load(csvLine(['First Name', 'Last Name', 'Email', 'Phone'])
      + csvLine(['Ana', 'Reyes', 'ana@example.test', '020 7946 0018']));
    expect((await source.run()).job).toMatchObject({ status: 'succeeded', committedRows: 1 });
    const saved = await snapshot();
    expect(saved.members[0]).toMatchObject({ phone: '020 7946 0018', phoneE164: '+442079460018',
      smsNoticesConsentAt: null, smsAnnouncementsConsentAt: null });
    expect(saved.households[0]).toMatchObject({ phone: '020 7946 0018', phoneE164: '+442079460018', smsNoticesConsentAt: null });
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
      + 'payer,Payer,Family,,cus_Family,card_Family\n';
    const result = await (await services().load(csv)).run();
    expect(result.job).toMatchObject({ status: 'succeeded', committedRows: 102 });
    const data = await snapshot();
    expect(data.households).toHaveLength(1); expect(new Set(data.members.map((member) => member.householdId)).size).toBe(1);
    expect(data.methods).toHaveLength(1); expect(data.households[0]).toMatchObject({ stripeCustomerId: 'cus_Family' });
  });
  it('analyzes chunks in any order exactly as one pass over the whole file', async () => {
    const existing = await factory('households', gymA, { stripeCustomerId: 'cus_Seen' });
    await factory('members', gymA, { householdId: existing.id, firstName: 'Old', lastName: 'Lake', email: 'old@example.test' });
    const rows = parseCsv(csvLine(['Member ID', 'First Name', 'Last Name', 'Email', 'Household External ID', 'Household Name', 'Billing Day',
      'Stripe Customer ID', 'Stripe Payment Method ID'])
      + csvLine(['p1', 'Pat', 'Lake', 'pat@example.test', '', 'Lake home', '5', 'cus_Lake', 'pm_Lake'])
      + csvLine(['p2', 'Sol', 'Lake', '', 'p1', 'Other name', '9', 'cus_Wrong', ''])
      + csvLine(['q1', 'Ira', 'Moss', 'ira@example.test', 'moss', '', '', 'cus_Lake', 'pm_Lake'])
      + csvLine(['', 'Pat', 'Lake', 'pat@example.test', '', '', '', '', ''])
      + csvLine(['solo', 'Una', 'Fern', '', '', '', '', 'cus_Solo', ''])
      + csvLine(['', 'Old', 'Lake', 'old@example.test', 'p1', '', '', '', ''])
      + csvLine(['', 'Ana', 'Reed', '', '', '', '', 'cus_Seen', 'pm_Reed'])).rows;
    const plan: ImportPlanRequest = { uploadId: uuidv7(), mapper: 'people', duplicatePolicy: 'error', mapping: autoMatch(Object.keys(rows[0]!.values)) };
    // Each pass gets its own copy of the rows, as each run parses its own file, so the chunked pass builds its own index.
    const context = (sourceRows: typeof rows): MapperContext => ({ gymId: gymA, actor: { kind: 'system' }, runId: uuidv7(), clock, timezone: 'UTC', sourceRows });
    const whole = await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, rows, plan, context(rows)));
    const chunked = context([...rows]), parts = [];
    for (const start of [6, 4, 2, 0]) parts.unshift(await database.forGym(gymA, (tx) => peopleMapper.analyze(tx, rows.slice(start, start + 2), plan, chunked)));
    expect(parts.flat()).toEqual(whole);
    const codes = whole.map((row) => row.issues.map((issue) => issue.code + ':' + issue.column));
    // The family finds the existing household through Old Lake, which has another customer.
    expect(codes[0]).toEqual(['conflict:Stripe Customer ID']);
    expect(codes[1]).toEqual(['invalid_value:Household Name', 'invalid_value:Billing Day', 'invalid_value:Stripe Customer ID', 'conflict:Stripe Customer ID']);
    expect(codes[2]).toEqual(['conflict:Stripe Customer ID', 'conflict:Stripe Payment Method ID']);
    expect(codes[3]).toEqual(['duplicate:null']);
    expect(whole[4]).toMatchObject({ action: 'create', values: { familyKey: JSON.stringify(['customer', 'cus_Solo']), householdName: 'Una Fern' } });
    expect(whole[5]).toMatchObject({ duplicateIds: [expect.any(String)], values: { householdId: existing.id } });
    expect(whole[6]).toMatchObject({ values: { householdId: existing.id, stripeCustomerId: 'cus_Seen' } });
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
    const { load } = services(familyPayments);
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
    const csv = 'First Name,Last Name,Email,Stripe Customer ID,Stripe Payment Method ID\nJo,Fields,jo@example.test,cus_Saved,card_New\n';
    await (await load(csv, { duplicatePolicy: 'update' })).run();
    await (await load(csv.replace('card_New', 'pm_Revoked'), { duplicatePolicy: 'update' })).run();
    const data = await snapshot(); expect(data.methods).toHaveLength(3);
    expect(data.methods.find((method) => method.processorId === 'pm_Default')!.isDefault).toBe(true);
    expect(data.methods.find((method) => method.processorId === 'card_New')!.isDefault).toBe(false);
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
      + csvLine(['One', 'Family', 'one', 'cus_One', 'card_Same']) + csvLine(['Two', 'Family', 'two', 'cus_Two', 'card_Same']);
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
    const orphan = await load('First Name,Last Name,Stripe Payment Method ID\nNew,Person,card_Orphan\n');
    expect((await orphan.run()).issues).toEqual([expect.objectContaining({ code: 'missing_required' })]);
    const data = await snapshot(); expect(data.methods).toHaveLength(0); expect(data.households[0]!.stripeCustomerId).toBe('cus_Original');
  });
});

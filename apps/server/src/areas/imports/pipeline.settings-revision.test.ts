// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The stored preview key follows specific gym settings columns, which these tests update directly.
import { gyms, uuidv7, writeAudit } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import type { ImportPlanRequest } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { createImportPipeline } from './pipeline.js';
import { autoMatch, parseCsv } from './pipeline.csv.js';
import { t } from './pipeline.messages.js';
import { MapperRegistry } from './mappers/registry.js';
import { createPeopleMapper } from './mappers/people.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2099-11-22T12:00:00Z');
let gymA: string, gymB: string;
let actorA: { readonly gymId: string; readonly actor: { readonly kind: 'system' } };
beforeEach(async () => {
  gymA = uuidv7(); gymB = uuidv7();
  actorA = { gymId: gymA, actor: { kind: 'system' } };
  await factory('gyms', gymA, { currency: 'USD', address: { country: 'US' }, bankDebitsEnabled: false });
  await factory('gyms', gymB, { currency: 'USD', address: { country: 'US' }, bankDebitsEnabled: false });
});

const source = 'First Name,Last Name,Stripe Customer ID,Stripe Payment Method ID\nAnn,Lee,cus_A1,pm_A1\n';
const planFor = (uploadId: string): ImportPlanRequest => ({ uploadId, mapper: 'people',
  mapping: autoMatch(parseCsv(source).columns), duplicatePolicy: 'error' });

/** The real people mapper with its prepare and analyze calls counted, over per-gym fake storage. */
function setup() {
  let provider: FakePayments | null = null;
  const stores = new Map<string, FakeUploads>();
  const uploadsFor = async (gymId: string) => {
    if (!stores.has(gymId)) stores.set(gymId, new FakeUploads(gymId, clock));
    return stores.get(gymId)!;
  };
  const mapper = createPeopleMapper(database.forGym, async () => provider);
  const prepare = vi.spyOn(mapper, 'prepare'), analyze = vi.spyOn(mapper, 'analyze');
  const pipeline = createImportPipeline({ uploadsFor, jobs: new FakeJobs(clock), scope: database.forGym, clock,
    mappers: new MapperRegistry([mapper]) });
  return { pipeline, prepare, analyze, setProvider(value: FakePayments | null) { provider = value; } };
}

/** Raises only `gyms.revision`, as an activity touch or unrelated setting save does. */
async function saveSetting(gymId: string) {
  await database.forGym(gymId, async (tx) => {
    const [gym] = await tx.select({ revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId));
    await tx.update(gyms).set({ revision: gym!.revision + 1 }).where(eq(gyms.id, gymId));
  });
}

async function saveBranding(gymId: string) {
  await database.forGym(gymId, async (tx) => {
    const [gym] = await tx.select({ revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId));
    await tx.update(gyms).set({ branding: { primaryColor: '#123456' }, revision: gym!.revision + 1 }).where(eq(gyms.id, gymId));
  });
}

async function setStripeStored(gymId: string, stored: boolean) {
  await database.forGym(gymId, async (tx) => {
    await tx.update(gyms).set({ stripeConfig: stored ? 'encrypted-config' : '' }).where(eq(gyms.id, gymId));
  });
}

async function setCurrency(gymId: string, currency: 'USD' | 'CAD') {
  await database.forGym(gymId, async (tx) => {
    await tx.update(gyms).set({ currency }).where(eq(gyms.id, gymId));
  });
}

async function setCountry(gymId: string, country: string | null) {
  await database.forGym(gymId, async (tx) => {
    await tx.update(gyms).set({ address: country ? { country } : {} }).where(eq(gyms.id, gymId));
  });
}

async function setBankDebits(gymId: string, bankDebitsEnabled: boolean) {
  await database.forGym(gymId, async (tx) => {
    await tx.update(gyms).set({ bankDebitsEnabled }).where(eq(gyms.id, gymId));
  });
}

async function writeStripeSaved(gymId: string, beforeMode: 'test' | 'live', afterMode: 'test' | 'live') {
  await database.forGym(gymId, async (tx) => {
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'integrations.stripe_saved', targetType: 'gym', targetId: gymId,
      before: { mode: beforeMode }, after: { mode: afterMode }, occurredAt: clock.now() });
  });
}

describe('stored import previews follow preview-relevant gym settings', () => {
  it('keeps serving a stored preview and ready ticket after raising gyms.revision or changing branding', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    const ticket = await pipeline.requestPreview(actorA, plan, page, 'UTC');
    if (!('id' in ticket)) throw new Error('A new upload should start a new preview');
    await expect.poll(() => pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
    expect(analyze).toHaveBeenCalledTimes(1);

    await saveSetting(gymA);
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });

    await saveBranding(gymA);
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(await pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
  });

  it('previews a payment method again after storing Stripe settings', async () => {
    const { pipeline, prepare, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    const before = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(before.summary.errors).toBe(1);
    expect(before.data[0]).toMatchObject({ action: 'error' });
    expect(prepare).toHaveBeenCalledTimes(1);
    setProvider(new FakePayments(gymA, clock));
    await setStripeStored(gymA, true);
    const after = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(after.summary.errors).toBe(0);
    expect(after.data[0]).toMatchObject({ action: 'create' });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('serves a second preview of the same plan from storage when no preview-relevant setting changes', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    const first = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(first.summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    const second = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(second.summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('previews a payment method again after clearing Stripe settings', async () => {
    const { pipeline, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    await setStripeStored(gymA, true);
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    setProvider(null);
    await setStripeStored(gymA, false);
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(1);
  });

  it.each([
    ['storing Stripe settings', async () => {}, () => setStripeStored(gymA, true)],
    ['clearing Stripe settings', () => setStripeStored(gymA, true), () => setStripeStored(gymA, false)],
    ['changing currency', async () => {}, () => setCurrency(gymA, 'CAD')],
    ['changing address country', async () => {}, () => setCountry(gymA, 'CA')],
    ['changing bankDebitsEnabled', async () => {}, () => setBankDebits(gymA, true)],
    ['switching Stripe mode', async () => {}, () => writeStripeSaved(gymA, 'test', 'live')],
  ] as const)('computes again and fails a ready ticket with previewChanged after %s', async (_label, seed, mutate) => {
    await seed();
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    const ticket = await pipeline.requestPreview(actorA, plan, page, 'UTC');
    if (!('id' in ticket)) throw new Error('A new upload should start a new preview');
    await expect.poll(() => pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
    expect(analyze).toHaveBeenCalledTimes(1);

    await mutate();
    expect(await pipeline.getPreview(gymA, upload.id, ticket.id, page))
      .toEqual({ status: 'failed', message: t('imports/pipeline:previewChanged') });
    await pipeline.preview(actorA, plan, page, 'UTC');
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it('keeps serving a stored preview and ready ticket when a Stripe save stays in the same mode', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    await setStripeStored(gymA, true);
    const ticket = await pipeline.requestPreview(actorA, plan, page, 'UTC');
    if (!('id' in ticket)) throw new Error('A new upload should start a new preview');
    await expect.poll(() => pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
    expect(analyze).toHaveBeenCalledTimes(1);

    await writeStripeSaved(gymA, 'test', 'test');
    expect(await pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
    await pipeline.preview(actorA, plan, page, 'UTC');
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('keeps serving gym A stored preview after gym B changes preview-relevant settings', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    await setStripeStored(gymB, true);
    await setCurrency(gymB, 'CAD');
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('does not invalidate a stored preview with a dry run', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    await pipeline.start(actorA, { ...plan, dryRun: true }, 'UTC');
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
  });
});

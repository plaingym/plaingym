// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The stored preview key follows the gym's settings revision, which these tests save directly.
import { gyms, uuidv7 } from '@plaingym/db';
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
const clock = new TestClock('2099-11-22T12:00:00Z'), gymA = uuidv7(), gymB = uuidv7();
const actorA = { gymId: gymA, actor: { kind: 'system' } } as const;
beforeAll(async () => { await factory('gyms', gymA); await factory('gyms', gymB); });

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

/** Saves any gym setting, which advances `gyms.revision` as every settings save and both Stripe save paths do. */
async function saveSetting(gymId: string) {
  await database.forGym(gymId, async (tx) => {
    const [gym] = await tx.select({ revision: gyms.revision }).from(gyms).where(eq(gyms.id, gymId));
    await tx.update(gyms).set({ revision: gym!.revision + 1 }).where(eq(gyms.id, gymId));
  });
}

describe('stored import previews follow the gym settings revision', () => {
  it('previews a payment method again after Stripe is connected and a setting is saved', async () => {
    const { pipeline, prepare, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    const before = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(before.summary.errors).toBe(1);
    expect(before.data[0]).toMatchObject({ action: 'error' });
    expect(prepare).toHaveBeenCalledTimes(1);
    setProvider(new FakePayments(gymA, clock));
    await saveSetting(gymA);
    const after = await pipeline.preview(actorA, plan, page, 'UTC');
    expect(after.summary.errors).toBe(0);
    expect(after.data[0]).toMatchObject({ action: 'create' });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('serves a second preview of the same plan from storage when no setting is saved', async () => {
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

  it('previews a payment method again after Stripe is removed and a setting is saved', async () => {
    const { pipeline, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    setProvider(null);
    await saveSetting(gymA);
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(1);
  });

  it('fails a stored ticket with previewChanged after a setting is saved', async () => {
    const { pipeline, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    const ticket = await pipeline.requestPreview(actorA, plan, page, 'UTC');
    if (!('id' in ticket)) throw new Error('A new upload should start a new preview');
    await expect.poll(() => pipeline.getPreview(gymA, upload.id, ticket.id, page)).toMatchObject({ status: 'ready' });
    await saveSetting(gymA);
    expect(await pipeline.getPreview(gymA, upload.id, ticket.id, page))
      .toEqual({ status: 'failed', message: t('imports/pipeline:previewChanged') });
  });

  it('keeps serving gym A stored preview after gym B saves a setting', async () => {
    const { pipeline, analyze, setProvider } = setup();
    const upload = await pipeline.upload(actorA, new File([source], 'people.csv')), plan = planFor(upload.id);
    const page = { limit: 10, offset: 0 };
    setProvider(new FakePayments(gymA, clock));
    expect((await pipeline.preview(actorA, plan, page, 'UTC')).summary.errors).toBe(0);
    expect(analyze).toHaveBeenCalledTimes(1);
    await saveSetting(gymB);
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

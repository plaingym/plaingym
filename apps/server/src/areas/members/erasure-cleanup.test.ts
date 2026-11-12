// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq, inArray } from 'drizzle-orm';
import { classBookings, members, paymentMethods, uuidv7, type forGym } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { errorHandler } from '../../core/errors.js';
import { setLogSink } from '../../core/log.js';
import { createServerRegistry } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import { FakeJobs, type Jobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { authorize } from '../staff/auth.permissions.js';
import { detachJob } from '../billing/payments.mutations.js';
import { createMembersService } from './members.js';
import { createErasureJobs, createMembersRoutes, releaseErasedFilesJob } from './members.routes.js';

// Promotion runs after the erasure commits; a throwing promotion (a lock timeout, or a session deleted meanwhile) is simulated here.
const promotion = vi.hoisted(() => ({ fail: new Set<string>(), calls: [] as string[], scope: undefined as typeof forGym | undefined }));
vi.mock('../bookings/bookings.js', async (load) => {
  const actual = await load<typeof import('../bookings/bookings.js')>();
  // The route promotes through the default database client; this file's test database stands in for it.
  return { ...actual, promoteWaitlist: async (...[gym, sessionId, options]: Parameters<typeof actual.promoteWaitlist>) => {
    promotion.calls.push(sessionId);
    if (promotion.fail.has(sessionId)) throw new Error('lock timeout');
    return actual.promoteWaitlist(gym, sessionId, { ...options, ...(promotion.scope ? { scope: promotion.scope } : {}) });
  } };
});

const database = useTestDatabase(), factory = createFactories(database);
promotion.scope = database.forGym;
const gymId = uuidv7(), clock = new TestClock('2026-11-06T12:00:00Z');
let userId: string;
beforeAll(async () => { await factory('gyms', gymId); userId = (await factory('authUser', gymId)).id; });

async function fixture(uploads: FakeUploads) {
  const home = await factory('households', gymId), person = await factory('members', gymId, { householdId: home.id });
  const cards = [await factory('paymentMethods', gymId, { householdId: home.id }), await factory('paymentMethods', gymId, { householdId: home.id })];
  const photoKey = `${gymId}/members/${person.id}/${uuidv7()}`, signatureKey = `${gymId}/waivers/${uuidv7()}/signatures/${uuidv7()}.png`;
  for (const key of [photoKey, signatureKey]) await uploads.put(key, new Uint8Array([1]), 'image/png');
  await database.forGym(gymId, tx => tx.update(members).set({ photoKey }).where(eq(members.id, person.id)));
  await factory('waiverSignatures', gymId, { memberId: person.id, signatureImageKey: signatureKey });
  // Two upcoming sessions the erasure frees a place in, each with someone waiting.
  const upcoming = { startsAt: new Date('2026-11-10T18:00:00Z'), endsAt: new Date('2026-11-10T19:00:00Z') };
  const sessions = [await factory('classSessions', gymId, { ...upcoming, capacity: 1 }), await factory('classSessions', gymId, { ...upcoming, capacity: 1 })];
  const waiting = [];
  for (const session of sessions) {
    await factory('classBookings', gymId, { sessionId: session.id, memberId: person.id, bookedBy: userId, status: 'booked' });
    waiting.push(await factory('classBookings', gymId, { sessionId: session.id, bookedBy: userId, status: 'waitlisted', waitlistPosition: 1 }));
  }
  return { person, cards, files: [photoKey, signatureKey], sessions, waiting };
}
function app(options: { jobs?: Pick<Jobs, 'enqueue'>; uploads: FakeUploads; detachCard?: () => Promise<void> }) {
  const server = new OpenAPIHono<RequestEnvironment>();
  server.use('*', async (ctx, next) => {
    ctx.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
      principal: { kind: 'staff', gymId, userId, roles: ['owner'] }, requestId: 'erasure-cleanup', clock });
    await next();
  });
  server.onError(errorHandler);
  const service = createMembersService({ scope: database.forGym, clock });
  createServerRegistry({ routes: createMembersRoutes(service, async () => options.uploads, {
    clock, ...(options.jobs ? { jobs: options.jobs } : {}), ...(options.detachCard ? { detachCard: options.detachCard } : {}) }) }).mount(server, authorize, new Set());
  return (id: string) => server.request(`/api/members/${id}/anonymize`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 1 }) });
}

describe('erasure cleanup after commit', () => {
  it('still queues every detach and the file release, and promotes the other sessions, when one promotion throws', async () => {
    const uploads = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock), { person, cards, files, sessions, waiting } = await fixture(uploads);
    promotion.fail.add(sessions[0]!.id);
    // The inline attempts fail too: the queued jobs are what keeps the detaches.
    const detachCard = vi.fn(async () => { throw new Error('Provider unavailable'); });
    const logs: { event?: string; sessionId?: string }[] = [], previous = setLogSink(entry => { logs.push(JSON.parse(entry)); });
    let status: number;
    try { status = (await app({ jobs, uploads, detachCard })(person.id)).status; } finally { setLogSink(previous); }
    expect(status).toBe(200);
    expect(jobs.jobs.filter(job => job.name === detachJob).map(job => job.payload)).toEqual(expect.arrayContaining(
      cards.map(card => ({ paymentMethodId: card.id, redactBillingDetails: true }))));
    expect(jobs.jobs.filter(job => job.name === releaseErasedFilesJob).map(job => job.payload)).toEqual([{ keys: files }]);
    expect(detachCard).toHaveBeenCalledTimes(2);
    // The inline release ran before promotion, and the failed promotion is logged with identifiers only.
    for (const key of files) expect((await uploads.head(key))!.deletedAt).toEqual(clock.now());
    expect(promotion.calls).toEqual(expect.arrayContaining(sessions.map(session => session.id)));
    expect(logs.filter(entry => entry.event === 'members.erasure.promotion_failed').map(entry => entry.sessionId)).toEqual([sessions[0]!.id]);
    expect(JSON.stringify(logs)).not.toMatch(/lock timeout|Provider unavailable/);
    const rows = await database.forGym(gymId, tx => tx.select().from(classBookings).where(inArray(classBookings.id, waiting.map(row => row.id))));
    expect(rows.find(row => row.id === waiting[0]!.id)!.status).toBe('waitlisted');
    expect(rows.find(row => row.id === waiting[1]!.id)!.status).toBe('booked');
    promotion.fail.clear();
  });
  it('releases the erased files from the committed job when the inline attempt never ran, and a repeat is harmless', async () => {
    const uploads = new FakeUploads(gymId, clock), jobs = new FakeJobs(clock), { person, files } = await fixture(uploads);
    // A crash right after commit: the route never reaches its inline attempts, so the files are still live.
    await createMembersService({ scope: database.forGym, clock }).eraseMember({ gymId, actor: { kind: 'system' } }, person.id, { revision: 1 }, { jobs, timezone: 'UTC' });
    for (const key of files) expect((await uploads.head(key))!.deletedAt).toBeUndefined();
    const [queued] = jobs.jobs.filter(job => job.name === releaseErasedFilesJob);
    const job = createErasureJobs({ uploadsFor: async () => uploads }).find(registration => registration.id === releaseErasedFilesJob)!;
    for (let attempt = 1; attempt <= 2; attempt++) await job.handler(queued!.payload, { jobId: 'release', gymId, timezone: 'UTC', attempt, clock });
    for (const key of files) expect((await uploads.head(key))!.deletedAt).toEqual(clock.now());
    // A key outside the job's gym, or a malformed payload, is refused before any storage call.
    const markDeleted = vi.spyOn(uploads, 'markDeleted');
    for (const payload of [{ keys: [`${uuidv7()}/members/x`] }, { keys: [] }, {}]) await expect(job.handler(payload,
      { jobId: 'release', gymId, timezone: 'UTC', attempt: 1, clock })).rejects.toThrow();
    expect(markDeleted).not.toHaveBeenCalled();
    await expect(createErasureJobs({}).find(registration => registration.id === releaseErasedFilesJob)!.handler(queued!.payload,
      { jobId: 'release', gymId, timezone: 'UTC', attempt: 1, clock })).rejects.toThrow('not configured');
  });
  it('refuses an erasure without a queue before changing anything', async () => {
    const uploads = new FakeUploads(gymId, clock), { person, cards, files } = await fixture(uploads);
    const detachCard = vi.fn(async () => undefined);
    expect((await app({ uploads, detachCard })(person.id)).status).toBe(503);
    expect((await database.forGym(gymId, tx => tx.select().from(members).where(eq(members.id, person.id))))[0]).toMatchObject({ anonymizedAt: null, revision: 1 });
    expect((await database.forGym(gymId, tx => tx.select().from(paymentMethods).where(inArray(paymentMethods.id, cards.map(card => card.id)))))
      .every(card => card.revokedAt === null)).toBe(true);
    for (const key of files) expect((await uploads.head(key))!.deletedAt).toBeUndefined();
    expect(detachCard).not.toHaveBeenCalled();
  });
});

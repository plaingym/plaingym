// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { and, eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- The test inspects which jobs its isolated database acknowledged.
import { auditEvents, jobs, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Use the fixture database for the production registrations.
import { closeDatabase, initializeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, errorResponse, staffRoles, type StaffRole } from '@plaingym/shared';
import { acknowledgeFailedJobsResponseSchema, healthTileSchema } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createApp } from '../../core/app.js';
import { authorize } from '../staff/auth.permissions.js';
import { PostgresJobs, PostgresJobStatsQuery } from '../../infra/jobs/postgres.js';
import { createFailedJobsAcknowledgement } from './failed-jobs.js';
import { createHealthService } from './status.js';
import { createStatusProviders } from './status.providers.js';
import { createStatusRoutes } from './status.routes.js';

const database = useTestDatabase(), factory = createFactories(database);
const clock = new TestClock('2026-10-22T12:00:00Z'), hour = 3_600_000;
const path = '/api/health/failed-jobs/acknowledge';
const env = { APP_ENCRYPTION_KEY: '09'.repeat(32), TENANCY: 'multi', UPLOADS_DIR: '/uploads', BACKUP_STAGING_DIR: '/staging', APP_VERSION: '0.1.0', SOURCE_URL: 'https://example.test/source/v0.1.0' };
const stats = new PostgresJobStatsQuery(database);

function server(principal: Principal, gymId: string) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (c, next) => { c.set('context', { gym: { gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'test' }); await next(); });
  app.onError((error, c) => c.json(errorResponse(error, 'test'), error instanceof AppError ? error.status : 500));
  const acknowledgement = createFailedJobsAcknowledgement({ scope: database.forGym, clock, queue: new PostgresJobs({ database, clock }) });
  const service = createHealthService(createStatusProviders({ env, scope: database.forGym, jobs: stats }));
  createServerRegistry({ routes: createStatusRoutes(() => service, acknowledgement) }).mount(app, authorize, new Set());
  return app;
}
const post = (app: OpenAPIHono<RequestEnvironment>, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function gym() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const userId = (await factory('authUser', gymId)).id as string;
  return { gymId, userId, as: (roles: StaffRole[]): Principal => ({ kind: 'staff', gymId, userId, roles }) };
}
const failedJob = (gymId: string, runAt = new Date(clock.now().getTime() - hour)) =>
  factory('jobs', gymId, { name: 'test.failed', status: 'failed', runAt, lastError: 'Failed' });
const acknowledgedAt = async (id: unknown) =>
  (await database.forSystem(tx => tx.select({ at: jobs.acknowledgedAt }).from(jobs).where(eq(jobs.id, id as string))))[0]!.at;
/** The request the tile sends, from a fresh tile read. */
const read = async (gymId: string) => ({ through: clock.now().toISOString(), failedVersion: (await stats.get(gymId)).failedVersion });
const audits = (gymId: string) => database.forGym(gymId, tx => tx.select().from(auditEvents)
  .where(and(eq(auditEvents.gymId, gymId), eq(auditEvents.action, 'health.failed_jobs.acknowledged'))));

describe('acknowledging failed jobs', () => {
  it('acknowledges a job through the production registrations and default service', async () => {
    const g = await gym(), job = await failedJob(g.gymId), body = await read(g.gymId);
    await initializeDatabase(database.appUrl);
    try {
      const origin = 'http://localhost';
      const app = createApp({ origin, authorize, skipSetup: true, contributions: areaContributions,
        resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: g.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
        session: async (c, next) => { c.set('context', { ...c.get('context'), principal: g.as(['owner']) }); await next(); },
      });
      const response = await app.request(origin + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: { acknowledged: 1 } });
      expect(await acknowledgedAt(job.id)).toBeInstanceOf(Date);
      expect(await audits(g.gymId)).toHaveLength(1);
    } finally { await closeDatabase(); }
  });

  it.each(staffRoles)('lets only settings managers acknowledge: %s', async (role) => {
    const g = await gym(), job = await failedJob(g.gymId);
    const response = await post(server(g.as([role]), g.gymId), await read(g.gymId));
    if (role === 'owner' || role === 'admin') {
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(acknowledgeFailedJobsResponseSchema.parse(await response.json())).toEqual({ data: { acknowledged: 1 } });
      expect(await acknowledgedAt(job.id)).toEqual(clock.now());
      expect(await audits(g.gymId)).toEqual([expect.objectContaining({ actorKind: 'user', actorUserId: g.userId, targetType: 'gym',
        targetId: g.gymId, after: { acknowledged: 1, through: clock.now().toISOString() } })]);
      const tile = (await createStatusProviders({ env, scope: database.forGym, jobs: stats }).find(provider => provider.id === 'failed_jobs')!
        .read({ gymId: g.gymId, roles: [role], clock }));
      expect(healthTileSchema.parse(tile)).toMatchObject({ status: 'healthy', details: { failed: 0 } });
    } else {
      expect(response.status).toBe(403);
      expect(await acknowledgedAt(job.id)).toBeNull();
      expect(await audits(g.gymId)).toEqual([]);
    }
  });

  it('refuses a stale version with 409 and changes nothing, then acknowledges exactly the jobs a fresh read counted', async () => {
    const g = await gym(), app = server(g.as(['owner']), g.gymId);
    const earlier = await failedJob(g.gymId), stale = await read(g.gymId);
    const later = await failedJob(g.gymId, new Date(clock.now().getTime() + hour));
    const refused = await post(app, stale);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: 'conflict', message: 'Failed jobs changed' } });
    expect(await acknowledgedAt(earlier.id)).toBeNull();
    expect(await acknowledgedAt(later.id)).toBeNull();
    expect(await audits(g.gymId)).toEqual([]);
    const fresh = await read(g.gymId);
    const response = await post(app, fresh);
    expect(response.status).toBe(200);
    expect(acknowledgeFailedJobsResponseSchema.parse(await response.json())).toEqual({ data: { acknowledged: 2 } });
    expect(await acknowledgedAt(earlier.id)).toEqual(clock.now());
    expect(await acknowledgedAt(later.id)).toEqual(clock.now());
    expect((await audits(g.gymId)).map(audit => audit.after)).toEqual([{ acknowledged: 2, through: fresh.through }]);
    // Once cleared, the tile's version is `none`: acknowledging it changes nothing and writes no audit.
    expect(await (await post(app, await read(g.gymId))).json()).toEqual({ data: { acknowledged: 0 } });
    expect(await audits(g.gymId)).toHaveLength(1);
  });

  it('refuses a body without an instant or a version', async () => {
    const g = await gym(), job = await failedJob(g.gymId), app = server(g.as(['owner']), g.gymId), valid = await read(g.gymId);
    for (const body of [{ ...valid, through: 'x' }, {}, { through: valid.through }, { failedVersion: valid.failedVersion },
      { ...valid, failedVersion: '' }, { ...valid, failedVersion: 'x'.repeat(65) }, { ...valid, extra: true }])
      expect((await post(app, body)).status).toBe(400);
    expect(await acknowledgedAt(job.id)).toBeNull();
  });

  it('never reaches another gym', async () => {
    const a = await gym(), b = await gym(), jobA = await failedJob(a.gymId), jobB = await failedJob(b.gymId);
    // A gym A owner on gym B's hostname is refused.
    expect((await post(server(a.as(['owner']), b.gymId), await read(b.gymId))).status).toBe(403);
    expect(await acknowledgedAt(jobB.id)).toBeNull();
    // Gym B's version never acknowledges gym A's jobs, and gym A's version doesn't match gym B's.
    expect((await post(server(a.as(['owner']), a.gymId), await read(b.gymId))).status).toBe(409);
    expect((await post(server(b.as(['owner']), b.gymId), await read(a.gymId))).status).toBe(409);
    expect(await acknowledgedAt(jobA.id)).toBeNull();
    expect(await acknowledgedAt(jobB.id)).toBeNull();
    const response = await post(server(b.as(['owner']), b.gymId), await read(b.gymId));
    expect(await response.json()).toEqual({ data: { acknowledged: 1 } });
    expect(await acknowledgedAt(jobA.id)).toBeNull();
    expect(await audits(a.gymId)).toEqual([]);
    expect((await stats.get(a.gymId)).failed).toBe(1);
  });
});

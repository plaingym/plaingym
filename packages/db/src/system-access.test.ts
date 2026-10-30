// SPDX-License-Identifier: AGPL-3.0-only
// Database-level system-table isolation, independent of the lint: these queries are exactly what the
// lint forbids in app code, issued directly to prove the database itself refuses cross-gym access.
import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { openConnection, scopedDatabase, type Transaction } from './client.js';
import { uuidv7 } from './id.js';
import * as schema from './schema/index.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';
const database = useTestDatabase();
const factory = createFactories(database);
const gymA = uuidv7(), gymB = uuidv7();
const denied = { cause: { code: '42501' } };
const raw = async (tx: Pick<Transaction, 'execute'>, query: string) => [...await tx.execute(sql.raw(query))] as Record<string, unknown>[];
const ids = (rows: Record<string, unknown>[]) => rows.map((row) => String(row.id)).sort();
let fixture: Record<string, string>;
beforeAll(async () => {
  await factory('gyms', gymA); await factory('gyms', gymB);
  const domainA = await factory('gymDomains', gymA), domainB = await factory('gymDomains', gymB);
  const jobA = await factory('jobs', gymA), jobB = await factory('jobs', gymB);
  const cursorA = await factory('jobScheduleCursors', gymA), cursorB = await factory('jobScheduleCursors', gymB);
  const [installJob] = await database.forSystem((tx) => tx.insert(schema.jobs)
    .values({ name: 'install', runAt: new Date('2026-01-01Z'), idempotencyKey: uuidv7() }).returning());
  const user = await factory('authUser', gymA);
  const sessionA = await factory('authSession', gymA, { userId: user.id }), sessionB = await factory('authSession', gymB, { userId: user.id });
  const eventA = await factory('stripeEvents', gymA), eventB = await factory('stripeEvents', gymB);
  const [installEvent] = await database.forSystem((tx) => tx.insert(schema.stripeEvents)
    .values({ eventId: 'evt_' + uuidv7(), type: 'test.event', payload: {} }).returning());
  await factory('authAccount', gymA, { userId: user.id });
  await factory('backupRuns', gymA);
  fixture = { domainA: domainA.id, domainB: domainB.id, jobA: jobA.id, jobB: jobB.id, installJob: installJob!.id,
    cursorA: cursorA.id, cursorB: cursorB.id,
    user: user.id, sessionA: sessionA.id, sessionB: sessionB.id, eventA: eventA.id, eventB: eventB.id, installEvent: installEvent!.id };
});

describe('gym context sees only its own system rows', () => {
  it('reads and updates only its own gym configuration, and never creates or deletes gyms', async () => {
    await database.forGym(gymA, async (tx) => {
      // The query the lint review found: raw SQL naming gyms returns this gym's row alone.
      expect(ids(await raw(tx, 'select id, stripe_config_encrypted from gyms'))).toEqual([gymA]);
      expect(ids(await tx.select().from(schema.gyms))).toEqual([gymA]);
      expect(await tx.update(schema.gyms).set({ name: 'Taken over' }).where(eq(schema.gyms.id, gymB)).returning()).toEqual([]);
      expect(await tx.update(schema.gyms).set({ name: 'Renamed' }).where(eq(schema.gyms.id, gymA)).returning()).toHaveLength(1);
      expect(await tx.delete(schema.gyms).where(eq(schema.gyms.id, gymA)).returning()).toEqual([]);
    });
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.gyms).values({ name: 'Rogue', slug: uuidv7() }))).rejects.toMatchObject(denied);
    expect(await database.forSystem((tx) => tx.select().from(schema.gyms).where(eq(schema.gyms.id, gymA)))).toHaveLength(1);
  });
  it('scopes domains, jobs, schedule cursors, sessions and webhook events to the gym, hiding install-level rows', async () => {
    await database.forGym(gymA, async (tx) => {
      expect(ids(await raw(tx, 'select id from gym_domains'))).toEqual([fixture.domainA]);
      expect(ids(await raw(tx, 'select id from jobs'))).toEqual([fixture.jobA]);
      expect(ids(await raw(tx, 'select id from job_schedule_cursors'))).toEqual([fixture.cursorA]);
      expect(await tx.update(schema.jobScheduleCursors).set({ lastOccurrence: new Date('2027-01-01Z') })
        .where(eq(schema.jobScheduleCursors.id, fixture.cursorB!)).returning()).toEqual([]);
      expect(ids(await raw(tx, 'select id from auth_session'))).toEqual([fixture.sessionA]);
      expect(ids(await raw(tx, 'select id from stripe_events'))).toEqual([fixture.eventA]);
    });
    const job = (gymId: string | null) => ({ gymId, name: 'test', runAt: new Date('2026-01-01Z'), idempotencyKey: uuidv7() });
    expect(await database.forGym(gymA, (tx) => tx.insert(schema.jobs).values(job(gymA)).returning())).toHaveLength(1);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.jobs).values(job(gymB)))).rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.jobs).values(job(null)))).rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.jobScheduleCursors).values({ gymId: gymB, name: 'test',
      expression: '0 0 * * *', timezone: 'UTC', lastOccurrence: new Date('2026-01-01Z') }))).rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.gymDomains).values({ gymId: gymB, hostname: uuidv7() + '.example.test' })))
      .rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.stripeEvents).values({ eventId: 'evt_' + uuidv7(), type: 't', payload: {} })))
      .rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.authSession)
      .values({ gymId: gymB, userId: fixture.user!, token: uuidv7(), expiresAt: new Date('2027-01-01Z') }))).rejects.toMatchObject(denied);
  });
  it('never sees or writes install-wide identity or backup history', async () => {
    await database.forGym(gymA, async (tx) => {
      for (const table of ['auth_user', 'auth_account', 'auth_verification', 'auth_rate_limit', 'backup_runs']) {
        expect(await raw(tx, `select * from ${table}`), table).toEqual([]);
      }
    });
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.authUser).values({ name: 'Rogue', email: uuidv7() + '@example.test' })))
      .rejects.toMatchObject(denied);
    await expect(database.forGym(gymA, (tx) => tx.insert(schema.backupRuns)
      .values({ kind: 'manual', startedAt: new Date(), objectPrefix: uuidv7() }))).rejects.toMatchObject(denied);
  });
});

describe('missing context fails closed', () => {
  it('shows no system rows and accepts no system writes without gym or system context', async () => {
    for (const table of ['gyms', 'gym_domains', 'jobs', 'job_schedule_cursors', 'auth_user', 'auth_session', 'auth_account', 'auth_verification',
      'auth_rate_limit', 'backup_runs', 'stripe_events']) {
      expect(await raw(database.app.db, `select * from ${table}`), table).toEqual([]);
    }
    await expect(database.app.db.insert(schema.gyms).values({ name: 'Rogue', slug: uuidv7() })).rejects.toMatchObject(denied);
  });
});

describe('system context', () => {
  it('lets infrastructure resolve hostnames, claim any job, and record install-level rows', async () => {
    await database.forSystem(async (tx) => {
      expect(ids(await tx.select().from(schema.gyms)).filter((id) => [gymA, gymB].includes(id))).toEqual([gymA, gymB].sort());
      const [domain] = await tx.select().from(schema.gymDomains).where(eq(schema.gymDomains.id, fixture.domainB!));
      expect(domain?.gymId).toBe(gymB);
      expect(ids(await raw(tx, 'select id from jobs'))).toEqual(expect.arrayContaining([fixture.jobA, fixture.jobB, fixture.installJob]));
      expect(ids(await raw(tx, 'select id from job_schedule_cursors'))).toEqual([fixture.cursorA, fixture.cursorB].sort());
      expect(ids(await raw(tx, 'select id from stripe_events'))).toEqual(expect.arrayContaining([fixture.eventA, fixture.eventB, fixture.installEvent]));
    });
    // The auth adapter's pool carries system context on every connection.
    expect(await database.system.db.select().from(schema.authUser).where(eq(schema.authUser.id, fixture.user!))).toHaveLength(1);
  });
  it('grants no tenant data: gym-owned tables still require their own gym', async () => {
    const member = await factory('members', gymA);
    expect(await database.forSystem((tx) => tx.select().from(schema.members).where(eq(schema.members.id, member.id)))).toEqual([]);
    expect(await database.system.db.select().from(schema.members).where(eq(schema.members.id, member.id))).toEqual([]);
  });
  it('never leaks onto a reused connection and never nests with a gym scope', async () => {
    const single = openConnection(database.appUrl, 1);
    try {
      const scoped = scopedDatabase(single.db);
      expect(ids(await scoped.forSystem((tx) => tx.select().from(schema.authUser).where(eq(schema.authUser.id, fixture.user!))))).toHaveLength(1);
      expect(ids(await scoped.forGym(gymA, (tx) => raw(tx, 'select id from gyms')))).toEqual([gymA]);
      expect(await raw(single.db, 'select id from auth_user')).toEqual([]);
      await expect(scoped.forSystem(() => scoped.forGym(gymA, async () => undefined))).rejects.toThrow('Nested');
      await expect(scoped.forGym(gymA, () => scoped.forSystem(async () => undefined))).rejects.toThrow('Nested');
    } finally { await single.close(); }
  });
});

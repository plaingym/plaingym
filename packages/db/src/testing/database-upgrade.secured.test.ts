// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection, type Connection } from '../client.js';
import { migrateDatabase } from '../migrate.js';
import { attendances, auditEvents } from '../schema/index.js';
import { uuidv7 } from '../id.js';
// Imported through testing/database so the test runner gives this file a database.
import { useUpgradeTestDatabase } from '../testing/database-upgrade.js';

// An install of the 0002 release ran that release's migrations and then the security step.
const database = useUpgradeTestDatabase('0002_rank_colors', { applySecurity: true });
const gymA = uuidv7(), gymB = uuidv7();

async function unforced(sql: Connection['sql']) {
  return Array.from(await sql`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity and not c.relforcerowsecurity order by c.relname`);
}
async function appCannotRewriteAudit(app: Connection['sql'], gymId: string) {
  await expect(app.begin(async (tx) => {
    await tx`select set_config('app.gym_id', ${gymId}, true)`;
    await tx`update audit_events set action = 'rewritten'`;
  })).rejects.toThrow('permission denied for table audit_events');
}
/** Writes as the app role in one gym's context, the way the running app wrote before the upgrade. */
async function seedGym(app: Connection['sql'], gymId: string) {
  const householdId = uuidv7(), memberId = uuidv7(), sessionId = uuidv7();
  await app.begin(async (tx) => {
    await tx`select set_config('app.system', 'on', true)`;
    await tx`insert into gyms (id, name, slug) values (${gymId}, 'Secured Gym', ${gymId})`;
  });
  const visits = [{ id: uuidv7(), sessionId, source: 'coach' }, { id: uuidv7(), sessionId: null, source: 'kiosk' }];
  await app.begin(async (tx) => {
    await tx`select set_config('app.gym_id', ${gymId}, true)`;
    await tx`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Secured Household')`;
    await tx`insert into members (id, gym_id, household_id, first_name, last_name) values (${memberId}, ${gymId}, ${householdId}, 'Secured', 'Member')`;
    await tx`insert into class_sessions (id, gym_id, name, starts_at, ends_at)
      values (${sessionId}, ${gymId}, 'Secured Class', '2026-01-15T12:00:00Z', '2026-01-15T13:00:00Z')`;
    for (const visit of visits) await tx`insert into attendances (id, gym_id, member_id, session_id, occurred_at, source)
      values (${visit.id}, ${gymId}, ${memberId}, ${visit.sessionId}, '2026-01-15T12:00:00Z', ${visit.source})`;
    await tx`insert into audit_events (id, gym_id, actor_kind, action, target_type, target_id, occurred_at)
      values (${uuidv7()}, ${gymId}, 'system', 'member.created', 'member', ${memberId}, '2026-01-15T12:00:00Z')`;
  });
  return { memberId, visits };
}

it('starts from the secured state an installed release had: forced row-level security and append-only audits', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1), app = openConnection(database.appUrl, 1);
  try {
    expect(await unforced(maintenance.sql)).toEqual([]);
    const [forced] = await maintenance.sql`select count(*)::int as count from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity`;
    expect(forced!.count).toBeGreaterThan(0);
    await appCannotRewriteAudit(app.sql, gymA);
  } finally { await app.close(); await maintenance.close(); }
});

it('upgrades a secured install in place: data migrations still reach every gym and the security step still holds', async () => {
  const app = openConnection(database.appUrl, 1);
  let seeded: Awaited<ReturnType<typeof seedGym>>[];
  try { seeded = [await seedGym(app.sql, gymA), await seedGym(app.sql, gymB)]; }
  finally { await app.close(); }

  await migrateDatabase(database.maintenanceUrl);

  // 0003 marks session-less live visits as open mat. Rows the app wrote under forced row-level security in two
  // gyms are all reached by the maintenance role (BYPASSRLS), and the secured start state doesn't block the upgrade.
  for (const [index, gymId] of [gymA, gymB].entries()) {
    const rows = await database.forGym(gymId, (tx) => tx.select({ id: attendances.id, kind: attendances.kind })
      .from(attendances).orderBy(asc(attendances.id)));
    expect(rows).toEqual(seeded[index]!.visits.map((visit) => ({ id: visit.id, kind: visit.sessionId ? 'class' : 'open_mat' }))
      .sort((a, b) => a.id.localeCompare(b.id)));
    expect(await database.forGym(gymId, (tx) => tx.select({ targetId: auditEvents.targetId }).from(auditEvents)
      .where(eq(auditEvents.action, 'member.created')))).toEqual([{ targetId: seeded[index]!.memberId }]);
  }
  const maintenance = openConnection(database.maintenanceUrl, 1), after = openConnection(database.appUrl, 1);
  try {
    // Tables added after the starting release (export_runs, from 0005) are forced too.
    expect(await unforced(maintenance.sql)).toEqual([]);
    const [added] = await maintenance.sql`select relforcerowsecurity as forced from pg_class where relname = 'export_runs'`;
    expect(added).toEqual({ forced: true });
    await appCannotRewriteAudit(after.sql, gymA);
  } finally { await after.close(); await maintenance.close(); }
});

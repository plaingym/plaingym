// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { authUser, authVerification, households, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- The upgrade test seeds the previous releases' rows and connects to its isolated database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
// eslint-disable-next-line database/system-tables -- The upgrade test applies the real migrations to its isolated database.
import { migrateDatabase } from '@plaingym/db/migrate';
import { useUpgradeTestDatabase } from '@plaingym/db/testing/database-upgrade';
import { TestClock } from '../../core/clock.js';
import { createPortalInvitationStore } from './portal-invitations.js';

const database = useUpgradeTestDatabase('0013_portal_invitation_columns', { applySecurity: true });
const clock = new TestClock('2026-10-31T12:00:00Z'), expiresAt = new Date('2026-11-07T12:00:00Z'), expired = new Date('2026-10-30T12:00:00Z');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

it('lists, counts, sweeps and keeps invitees of invitations that processes on the two previous releases wrote during an upgrade', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7();
  const homes = { early: uuidv7(), late: uuidv7(), member: uuidv7(), stale: uuidv7(), after: uuidv7() };
  const users = { early: uuidv7(), late: uuidv7(), member: uuidv7(), stale: uuidv7(), after: uuidv7() };
  const ids = { early: uuidv7(), late: uuidv7(), member: uuidv7(), stale: uuidv7(), magic: uuidv7() };
  const binding = (user: string, household: string, scope = 'payer') => JSON.stringify({ userId: user, householdId: household, scope, memberId: scope === 'member' ? uuidv7() : null });
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const id of [gymId, otherGymId]) await maintenance.sql`insert into gyms (id, name, slug) values (${id}, 'Test Gym', ${id})`;
    for (const household of Object.values(homes)) await maintenance.sql`insert into households (id, gym_id, name) values (${household}, ${gymId}, 'Household')`;
    for (const user of Object.values(users)) await maintenance.sql`insert into auth_user (id, name, email) values (${user}, 'Invitee', ${user + '@example.test'})`;
    // A process still on the release before 0013 wrote the identifier and value only.
    const early = (id: string, user: string, household: string, at: Date, token: string) => maintenance.sql`insert into auth_verification (id, identifier, value, expires_at)
      values (${id}, ${`portal-invitation:${gymId}:${hash(token)}`}, ${binding(user, household)}, ${at.toISOString()})`;
    await early(ids.early, users.early, homes.early, expiresAt, 'early');
    await early(ids.stale, users.stale, homes.stale, expired, 'stale');
    // A process on the release before this one wrote the columns, but no scope.
    const late = (id: string, user: string, household: string, scope: string, token: string) => maintenance.sql`insert into auth_verification
      (id, identifier, value, expires_at, gym_id, household_id, user_id) values (${id}, ${`portal-invitation:${gymId}:${hash(token)}`},
      ${binding(user, household, scope)}, ${expiresAt.toISOString()}, ${gymId}, ${household}, ${user})`;
    await late(ids.late, users.late, homes.late, 'payer', 'late');
    await late(ids.member, users.member, homes.member, 'member', 'member');
    await maintenance.sql`insert into auth_verification (id, identifier, value, expires_at) values (${ids.magic}, ${hash('magic')}, 'not json {', ${expiresAt.toISOString()})`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const system = openConnection(database.appUrl, 2, 'system');
  try {
    const rows = new Map((await system.db.select().from(authVerification)).map(row => [row.id, row]));
    expect(rows.get(ids.early)).toMatchObject({ gymId, householdId: homes.early, userId: users.early, scope: 'payer' });
    expect(rows.get(ids.stale)).toMatchObject({ gymId, householdId: homes.stale, userId: users.stale, scope: 'payer' });
    expect(rows.get(ids.late)).toMatchObject({ gymId, householdId: homes.late, userId: users.late, scope: 'payer' });
    expect(rows.get(ids.member)).toMatchObject({ scope: 'member' });
    expect(rows.get(ids.magic)).toMatchObject({ value: 'not json {', gymId: null, householdId: null, userId: null, scope: null });

    const store = createPortalInvitationStore(() => system.db);
    // A process still on the previous release keeps writing invitations without a scope until it stops.
    await system.db.insert(authVerification).values({ identifier: `portal-invitation:${gymId}:${hash('after')}`, value: binding(users.after, homes.after),
      expiresAt, gymId, householdId: homes.after, userId: users.after });
    // Listed for staff, and kept off the confirmation shortlist; a member invitation never is.
    expect((await store.outstanding(gymId, homes.early, clock)).map(row => row.id)).toEqual([ids.early]);
    expect((await store.outstanding(gymId, homes.late, clock)).map(row => row.id)).toEqual([ids.late]);
    const invited = await store.withPayerInvitations(gymId, clock, (tx, payerInvited) => tx.select({ id: households.id }).from(households)
      .where(payerInvited(households.id)));
    expect(invited.map(row => row.id).sort()).toEqual([homes.early, homes.late, homes.after].sort());
    // Swept with its invitee once expired.
    expect(await store.expire(gymId, clock)).toEqual({ expired: 1, removed: 1 });
    expect(await system.db.select().from(authUser).where(eq(authUser.id, users.stale))).toEqual([]);
    // Counted when another gym's invitation for the same identity goes: it keeps the invitee, until it goes too.
    const issued = await scopedDatabase(system.db).forGym(otherGymId, tx => store.issue(tx, otherGymId,
      { userId: users.early, householdId: uuidv7(), scope: 'payer', memberId: null }, clock));
    const [theirs] = await system.db.select().from(authVerification).where(eq(authVerification.identifier, `portal-invitation:${otherGymId}:${hash(issued.token)}`));
    await store.revoke({ gymId: otherGymId, householdId: theirs!.householdId!, invitationId: theirs!.id, clock }, async () => undefined);
    expect(await system.db.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, users.early))).toHaveLength(1);
    await store.revoke({ gymId, householdId: homes.early, invitationId: ids.early, clock }, async () => undefined);
    expect(await system.db.select({ id: authUser.id }).from(authUser).where(inArray(authUser.id, [users.early, users.stale]))).toEqual([]);
  } finally { await system.close(); }
});

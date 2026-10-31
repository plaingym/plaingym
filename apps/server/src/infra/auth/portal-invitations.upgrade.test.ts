// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authUser, authVerification, uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables -- The upgrade test seeds the previous release's rows and connects to its isolated database.
import { openConnection, scopedDatabase } from '@plaingym/db/client';
// eslint-disable-next-line database/system-tables -- The upgrade test applies the real migrations to its isolated database.
import { migrateDatabase } from '@plaingym/db/migrate';
import { useUpgradeTestDatabase } from '@plaingym/db/testing/database-upgrade';
import { TestClock } from '../../core/clock.js';
import { createPortalInvitationStore } from './portal-invitations.js';

const database = useUpgradeTestDatabase('0012_job_schedule_cursors', { applySecurity: true });
const clock = new TestClock('2026-10-30T12:00:00Z'), expiresAt = new Date('2026-11-06T12:00:00Z');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

it('lists, sweeps and revokes invitations issued before the upgrade, and leaves Better Auth rows as they were', async () => {
  const gymId = uuidv7(), userId = uuidv7(), householdId = uuidv7(), goneGym = uuidv7(), ids = { invitation: uuidv7(), magic: uuidv7(), staff: uuidv7(), orphan: uuidv7(), broken: uuidv7(), badId: uuidv7(), badGym: uuidv7() };
  const value = JSON.stringify({ userId, householdId, scope: 'payer', memberId: null });
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into auth_user (id, name, email) values (${userId}, 'Invitee', ${userId + '@example.test'})`;
    const row = (id: string, identifier: string, text: string) => maintenance.sql`insert into auth_verification (id, identifier, value, expires_at)
      values (${id}, ${identifier}, ${text}, ${expiresAt.toISOString()})`;
    // The release before kept the household only inside the JSON value.
    await row(ids.invitation, `portal-invitation:${gymId}:${hash('token')}`, value);
    // Better Auth's own rows aren't JSON, and a staff invitation isn't a portal invitation.
    await row(ids.magic, hash('magic'), 'not json {');
    await row(ids.staff, `staff-invitation:${gymId}:${hash('staff')}`, JSON.stringify({ userId, staffRoleId: uuidv7(), role: 'coach', revision: 1 }));
    // An invitation of a deleted gym can't take that gym's ID; it is left as it was.
    await row(ids.orphan, `portal-invitation:${goneGym}:${hash('gone')}`, JSON.stringify({ userId, householdId: uuidv7(), scope: 'payer', memberId: null }));
    // Malformed invitations never fail the upgrade; they couldn't be accepted before it either.
    await row(ids.broken, `portal-invitation:${gymId}:${hash('broken')}`, '{"userId":');
    await row(ids.badId, `portal-invitation:${gymId}:${hash('bad')}`, JSON.stringify({ userId, householdId: 'not-a-uuid', scope: 'payer', memberId: null }));
    await row(ids.badGym, `portal-invitation:not-a-gym:${hash('gym')}`, value);
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const system = openConnection(database.appUrl, 2, 'system');
  try {
    const rows = await system.db.select().from(authVerification);
    const byId = (id: string) => rows.find(entry => entry.id === id);
    expect(byId(ids.invitation)).toMatchObject({ value, expiresAt, gymId, householdId, userId });
    expect(byId(ids.magic)).toMatchObject({ value: 'not json {', gymId: null, householdId: null, userId: null });
    expect(byId(ids.staff)).toMatchObject({ gymId: null, householdId: null, userId: null });
    for (const id of [ids.orphan, ids.broken, ids.badId, ids.badGym]) expect(byId(id)).toMatchObject({ gymId: null, householdId: null, userId: null });

    const store = createPortalInvitationStore(() => system.db);
    expect(await store.outstanding(gymId, householdId, clock)).toEqual([{ id: ids.invitation, expiresAt, email: userId + '@example.test',
      binding: { userId, householdId, scope: 'payer', memberId: null } }]);
    expect(await store.payerInvitationHouseholds(gymId, clock)).toEqual([householdId]);
    // Inviting the same household login again replaces the old invitation instead of adding a second one.
    await scopedDatabase(system.db).forGym(gymId, tx => store.issue(tx, gymId, { userId, householdId, scope: 'payer', memberId: null }, clock));
    const [current] = await store.outstanding(gymId, householdId, clock);
    expect(current?.id).not.toBe(ids.invitation);
    // Revoking it deletes the identity, which holds nothing else: a real staff invitation also has its staff role row,
    // whose foreign key would keep it. The rows left without indexed columns never block that.
    await store.revoke({ gymId, householdId, invitationId: current!.id, clock }, async () => undefined);
    expect(await system.db.select().from(authUser).where(eq(authUser.id, userId))).toEqual([]);
    expect(await store.outstanding(gymId, householdId, clock)).toEqual([]);
    expect((await system.db.select().from(authVerification)).map(entry => entry.id).sort()).toEqual([ids.magic, ids.staff, ids.orphan, ids.broken, ids.badId, ids.badGym].sort());
  } finally { await system.close(); }
});

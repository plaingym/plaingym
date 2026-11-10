// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { announcements, announcementRecipients } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0024_announcements', { applySecurity: true });
it('upgrades populated announcements, preserves generations and repairs previously unchecked lifecycle pairs', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), userId = uuidv7();
  const ids = Array.from({ length: 4 }, () => uuidv7());
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Upgrade', ${gymId})`;
    await maintenance.sql`insert into auth_user (id, name, email) values (${userId}, 'Owner', ${userId + '@example.test'})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    for (const [index, id] of ids.entries()) {
      const status = index % 2 ? 'sent' : 'sending';
      const completedAt = index < 2 ? null : '2026-11-09T00:00:00Z';
      await maintenance.sql`insert into announcements (id, gym_id, created_by, subject, body, audience, status, completed_at)
        values (${id}, ${gymId}, ${userId}, 'Notice', 'Original body', '{"statuses":["active"],"programIds":[]}', ${status}, ${completedAt})`;
      const state = ['pending', 'sent', 'failed', 'skipped'][index]!;
      await maintenance.sql`insert into announcement_recipients (id, gym_id, announcement_id, member_id, state, reason)
        values (${uuidv7()}, ${gymId}, ${id}, ${memberId}, ${state}, ${index < 2 ? 'unknown' : null})`;
    }
    await migrateDatabase(database.maintenanceUrl);
    const rows = await database.forGym(gymId, tx => tx.select().from(announcements).orderBy(announcements.id));
    expect(rows.map(row => row.id)).toEqual([...ids].sort());
    for (const row of rows) {
      expect(row.sendGeneration).toBe(row.id); expect(row.body).toBe('Original body');
      expect(row.completedAt !== null).toBe(row.status === 'sent');
    }
    const recipients = await database.forGym(gymId, tx => tx.select().from(announcementRecipients));
    for (const row of recipients) expect(row.reason).toBe(row.state === 'failed' ? 'unknown' : row.state === 'skipped' ? 'ineligible' : null);
    const indexes = await maintenance.sql`select indexname from pg_indexes where indexname in ('email_deliveries_command_idx', 'announcement_recipients_member_idx')`;
    expect(indexes).toHaveLength(2);
  } finally { await maintenance.close(); }
});

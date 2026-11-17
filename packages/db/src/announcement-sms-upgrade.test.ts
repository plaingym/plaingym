// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { announcementRecipients, announcementSmsRecipients, announcements } from './schema/index.js';
import { assertCatalog } from './security/catalog.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const db = useUpgradeTestDatabase('0035_sms', { applySecurity: true });
it('expands populated email announcements without rewriting their content or recipient outcomes', async () => {
  const connection = openConnection(db.maintenanceUrl, 1), gym = uuidv7(), user = uuidv7(), home = uuidv7(), member = uuidv7(), id = uuidv7(), recipient = uuidv7();
  try {
    await connection.sql`insert into gyms (id, name, slug) values (${gym}, 'Upgrade', ${gym})`;
    await connection.sql`insert into auth_user (id, name, email) values (${user}, 'Owner', ${user + '@example.test'})`;
    await connection.sql`insert into households (id, gym_id, name) values (${home}, ${gym}, 'Family')`;
    await connection.sql`insert into members (id, gym_id, household_id, first_name, last_name) values (${member}, ${gym}, ${home}, 'Test', 'Member')`;
    await connection.sql`insert into announcements (id, gym_id, created_by, send_generation, subject, body, audience, recipient_count, status, completed_at)
      values (${id}, ${gym}, ${user}, ${uuidv7()}, 'Email', 'Original body', '{"statuses":["active"],"programIds":[]}', 1, 'sent', '2026-11-10T12:00:00Z')`;
    await connection.sql`insert into announcement_recipients (id, gym_id, announcement_id, member_id, state) values (${recipient}, ${gym}, ${id}, ${member}, 'sent')`;
    const before = await connection.sql`select * from announcement_recipients where id = ${recipient}`;
    await migrateDatabase(db.maintenanceUrl);
    const row = (await db.forGym(gym, tx => tx.select().from(announcements)))[0]!;
    expect(row).toMatchObject({ id, body: 'Original body', recipientCount: 1, status: 'sent', smsBody: null, smsRecipientCount: 0,
      smsSent: 0, smsFailed: 0, smsSkipped: 0, smsScheduledFor: null, smsCompletedAt: null });
    expect(await connection.sql`select * from announcement_recipients where id = ${recipient}`).toEqual(before);
    expect(await db.forGym(gym, tx => tx.select().from(announcementRecipients))).toHaveLength(1);
    expect(await db.forGym(gym, tx => tx.select().from(announcementSmsRecipients))).toEqual([]);
    // The previous release can still insert and read an email-only announcement with its original columns.
    await connection.sql`insert into announcements (id, gym_id, created_by, send_generation, subject, body, audience)
      values (${uuidv7()}, ${gym}, ${user}, ${uuidv7()}, 'Old writer', 'Email only', '{"statuses":["active"],"programIds":[]}')`;
    expect(await assertCatalog(connection.sql)).toEqual({ tableCount: 73, tenantTableCount: 61 });
  } finally { await connection.close(); }
});

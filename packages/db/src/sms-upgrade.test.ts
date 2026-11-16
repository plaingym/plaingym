// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { assertCatalog } from './security/catalog.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const db = useUpgradeTestDatabase('0034_invoice_billed_terms', { applySecurity: true });
it('preserves existing phones, starts consent empty and SMS disabled, and forces the new tables', async () => {
  const connection = openConnection(db.maintenanceUrl, 1), gym = uuidv7(), household = uuidv7(), member = uuidv7();
  try {
    await connection.sql`insert into gyms (id, name, slug) values (${gym}, 'Gym', ${gym})`;
    await connection.sql`insert into households (id, gym_id, name, phone) values (${household}, ${gym}, 'Household', '202-555-0123')`;
    await connection.sql`insert into members (id, gym_id, household_id, first_name, last_name, phone) values (${member}, ${gym}, ${household}, 'Test', 'Member', '202-555-0123')`;
    await migrateDatabase(db.maintenanceUrl);
    expect((await connection.sql`select member_sms_enabled, sms_daily_cap, sms_config_encrypted from gyms where id = ${gym}`)[0])
      .toEqual({ member_sms_enabled: false, sms_daily_cap: 1000, sms_config_encrypted: null });
    expect((await connection.sql`select phone, phone_e164, sms_notices_consent_at, sms_announcements_consent_at from members where id = ${member}`)[0])
      .toEqual({ phone: '202-555-0123', phone_e164: null, sms_notices_consent_at: null, sms_announcements_consent_at: null });
    expect((await connection.sql`select phone, phone_e164, sms_notices_consent_at from households where id = ${household}`)[0])
      .toEqual({ phone: '202-555-0123', phone_e164: null, sms_notices_consent_at: null });
    expect(await assertCatalog(connection.sql)).toEqual({ tableCount: 72, tenantTableCount: 60 });
  } finally { await connection.close(); }
});

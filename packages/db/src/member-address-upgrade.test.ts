// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { members } from './schema/index.js';
import { normalizeAddress } from './schema/member-address.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const db = useUpgradeTestDatabase('0029_plan_switch_schema', { applySecurity: true });
it('computes existing addresses without changing emails or preferences and follows later email writes', async () => {
  const maintenance = openConnection(db.maintenanceUrl, 1), gymId = uuidv7(), householdId = uuidv7();
  const addresses = ['\t LEGACY@example.test\u00a0', 'Plain@example.test', '\t\u00a0', null];
  const ids = addresses.map(() => uuidv7());
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Upgrade', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    for (const [i, email] of addresses.entries()) await maintenance.sql`insert into members
      (id, gym_id, household_id, first_name, last_name, email, email_opt_out)
      values (${ids[i]!}, ${gymId}, ${householdId}, 'Test', 'Member', ${email}, true)`;
    await migrateDatabase(db.maintenanceUrl);
    const rows = await db.forGym(gymId, tx => tx.select().from(members).orderBy(members.id));
    expect(rows).toHaveLength(addresses.length);
    for (const row of rows) {
      const email = addresses[ids.indexOf(row.id)]!;
      expect(row.email).toBe(email);
      expect(row.emailAddress).toBe(email === null ? null : normalizeAddress(email));
      expect(row.emailOptOut).toBe(true); expect(row.revision).toBe(1);
    }
    const [updated] = await db.forGym(gymId, tx => tx.update(members).set({ email: '\u00a0NEW@example.test\t' })
      .where(eq(members.id, ids[0]!)).returning());
    expect(updated!.emailAddress).toBe('new@example.test');
    const [erased] = await db.forGym(gymId, tx => tx.update(members).set({ email: null })
      .where(eq(members.id, ids[0]!)).returning());
    expect(erased!.emailAddress).toBeNull();
    const indexes = await maintenance.sql`select indexname from pg_indexes where indexname = 'members_gym_address_idx'`;
    expect(indexes).toHaveLength(1);
  } finally { await maintenance.close(); }
});

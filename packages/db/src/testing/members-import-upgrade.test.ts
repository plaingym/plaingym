// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openConnection } from '../client.js';
import { uuidv7 } from '../id.js';
import { migrateDatabase } from '../migrate.js';
import { members } from '../schema/index.js';
import { useUpgradeTestDatabase } from '../testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0018_signed_links_campaign_index', { applySecurity: true });
it('upgrades populated members, maintains folded names and emails on updates, and preserves gym isolation', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  const gymA = uuidv7(), gymB = uuidv7(), memberA = uuidv7();
  try {
    for (const gymId of [gymA, gymB]) {
      const householdId = uuidv7(), id = gymId === gymA ? memberA : uuidv7();
      await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Upgrade', ${gymId})`;
      await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
      await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name, email)
        values (${id}, ${gymId}, ${householdId}, 'Jo', 'MiXeD_%', 'MiXeD_%@Example.test')`;
    }
    await migrateDatabase(database.maintenanceUrl);
    const rows = await database.forGym(gymA, tx => tx.select().from(members));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: memberA, lastName: 'MiXeD_%', lastNameFolded: 'mixed_%', emailFolded: 'mixed_%@example.test' });
    await database.forGym(gymA, tx => tx.update(members).set({ lastName: 'NewName', email: 'NEW@Example.test' }).where(eq(members.id, memberA)));
    expect((await database.forGym(gymA, tx => tx.select().from(members)))[0]).toMatchObject({ lastNameFolded: 'newname', emailFolded: 'new@example.test' });
    for (const column of ['last_name', 'email']) {
      const index = await maintenance.sql`select indexdef from pg_indexes where indexname = ${'members_gym_' + column + '_folded_idx'}`;
      expect(index[0]!.indexdef).toContain(`(gym_id, ${column}_folded)`);
      expect(index[0]!.indexdef).toContain('anonymized_at IS NULL');
    }
    await database.forGym(gymA, tx => tx.update(members).set({ email: null }).where(eq(members.id, memberA)));
    expect((await database.forGym(gymA, tx => tx.select().from(members)))[0]!.emailFolded).toBeNull();
    expect(await database.forGym(gymB, tx => tx.select().from(members).where(eq(members.id, memberA)))).toEqual([]);
  } finally { await maintenance.close(); }
});

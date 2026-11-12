// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openConnection } from './client.js';
import { databaseCode } from './errors.js';
import { migrateDatabase } from './migrate.js';
import { chargeTypes, gyms } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0031_discount_catalog');
const code = (run: () => Promise<unknown>) => run().then(() => 'succeeded', (error: unknown) => databaseCode(error));

it('keeps a gym\'s own drop-in charge type, archived or not, clears one naming none of its own, then enforces the key', async () => {
  const kept = uuidv7(), archived = uuidv7(), foreign = uuidv7(), unknown = uuidv7(), unset = uuidv7();
  const keptCharge = uuidv7(), archivedCharge = uuidv7();
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const id of [kept, archived, foreign, unknown, unset])
      await maintenance.sql`insert into gyms (id, name, slug, currency) values (${id}, 'Gym', ${id}, 'CAD')`;
    await maintenance.sql`insert into charge_types (id, gym_id, name, amount_cents, currency) values (${keptCharge}, ${kept}, 'Mat fee', 2500, 'CAD')`;
    await maintenance.sql`insert into charge_types (id, gym_id, name, amount_cents, currency, active)
      values (${archivedCharge}, ${archived}, 'Old mat fee', 2000, 'CAD', false)`;
    // Without a key, a stale or foreign ID could be stored: here another gym's charge type and one that never existed.
    for (const [gym, charge] of [[kept, keptCharge], [archived, archivedCharge], [foreign, keptCharge], [unknown, uuidv7()]] as const)
      await maintenance.sql`update gyms set drop_in_charge_type_id = ${charge} where id = ${gym}`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  const setting = async (gymId: string) => (await database.forGym(gymId, tx => tx.select({ id: gyms.dropInChargeTypeId, revision: gyms.revision })
    .from(gyms).where(eq(gyms.id, gymId))))[0];
  expect(await setting(kept)).toEqual({ id: keptCharge, revision: 1 });
  expect(await setting(archived)).toEqual({ id: archivedCharge, revision: 1 });
  for (const gymId of [foreign, unknown, unset]) expect(await setting(gymId)).toEqual({ id: null, revision: 1 });

  // The app role can no longer store another gym's charge type or an unknown one, and can still clear or reset its own.
  for (const charge of [keptCharge, uuidv7()])
    expect(await code(() => database.forGym(foreign, tx => tx.update(gyms).set({ dropInChargeTypeId: charge }).where(eq(gyms.id, foreign))))).toBe('23503');
  await database.forGym(archived, tx => tx.update(gyms).set({ dropInChargeTypeId: null }).where(eq(gyms.id, archived)));
  await database.forGym(archived, tx => tx.update(gyms).set({ dropInChargeTypeId: archivedCharge }).where(eq(gyms.id, archived)));
  expect(await setting(archived)).toEqual({ id: archivedCharge, revision: 1 });

  const after = openConnection(database.maintenanceUrl, 1);
  try {
    // A chosen charge type can't be deleted from under the setting, but deleting its gym removes both.
    expect(await code(() => after.sql`delete from charge_types where id = ${keptCharge}`)).toBe('23503');
    await after.sql`delete from gyms where id = ${kept}`;
    expect(await after.sql`select id from charge_types where gym_id = ${kept}`).toHaveLength(0);
    const [constraint] = await after.sql`select convalidated from pg_constraint where conname = 'gyms_drop_in_charge_type_fk'`;
    expect(constraint).toMatchObject({ convalidated: true });
  } finally { await after.close(); }
  expect(await database.forGym(archived, tx => tx.select({ id: chargeTypes.id, active: chargeTypes.active }).from(chargeTypes)))
    .toEqual([{ id: archivedCharge, active: false }]);
});

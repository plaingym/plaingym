// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { openConnection } from './client.js';
import { migrateDatabase } from './migrate.js';
import { chargeTypes, gyms } from './schema/index.js';
import { uuidv7 } from './id.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';

const database = useUpgradeTestDatabase('0015_refund_canceled');

it('adds a nullable drop-in charge type that existing gyms leave unset', async () => {
  const gymId = uuidv7(), otherGym = uuidv7(), chargeId = uuidv7(), laterGym = uuidv7();
  const maintenance = openConnection(database.maintenanceUrl, 1);
  try {
    for (const [id, name] of [[gymId, 'Test Gym'], [otherGym, 'Other Gym']] as const)
      await maintenance.sql`insert into gyms (id, name, slug, currency, retry_days) values (${id}, ${name}, ${id}, 'CAD', '{2,5}')`;
    await maintenance.sql`insert into charge_types (id, gym_id, name, amount_cents, currency) values (${chargeId}, ${gymId}, 'Drop-in', 2500, 'CAD')`;
  } finally { await maintenance.close(); }

  await migrateDatabase(database.maintenanceUrl);
  for (const [id, name] of [[gymId, 'Test Gym'], [otherGym, 'Other Gym']] as const) {
    const [row] = await database.forGym(id, tx => tx.select().from(gyms).where(eq(gyms.id, id)));
    expect(row).toMatchObject({ id, name, slug: id, currency: 'CAD', retryDays: [2, 5], revision: 1, dropInChargeTypeId: null });
  }
  // The new column names no fee by itself, even with a charge type called "Drop-in".
  expect(await database.forGym(gymId, tx => tx.select().from(chargeTypes).orderBy(asc(chargeTypes.id))))
    .toMatchObject([{ id: chargeId, gymId, name: 'Drop-in', amountCents: 2500, currency: 'CAD', active: true }]);

  // A previous-release insert omits the column and still works.
  const later = openConnection(database.maintenanceUrl, 1);
  try { await later.sql`insert into gyms (id, name, slug) values (${laterGym}, 'Later Gym', ${laterGym})`; }
  finally { await later.close(); }
  expect(await database.forGym(laterGym, tx => tx.select({ dropInChargeTypeId: gyms.dropInChargeTypeId }).from(gyms))).toEqual([{ dropInChargeTypeId: null }]);

  // The app role can set it under row-level security after the upgrade.
  await database.forGym(gymId, tx => tx.update(gyms).set({ dropInChargeTypeId: chargeId }).where(eq(gyms.id, gymId)));
  expect(await database.forGym(gymId, tx => tx.select({ dropInChargeTypeId: gyms.dropInChargeTypeId }).from(gyms))).toEqual([{ dropInChargeTypeId: chargeId }]);
});

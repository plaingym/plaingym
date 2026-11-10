// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { openConnection } from './client.js';
import { uuidv7 } from './id.js';
import { migrateDatabase } from './migrate.js';
import { announcementOptOuts, announcementRecipients, announcements, signedLinks } from './schema/index.js';
import { useUpgradeTestDatabase } from './testing/database-upgrade.js';
import { createFactories } from './testing/factories.js';

const database = useUpgradeTestDatabase('0023_waiver_documents', { applySecurity: true });

it('preserves every existing link purpose while adding empty announcement tables', async () => {
  const maintenance = openConnection(database.maintenanceUrl, 1);
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), invoiceId = uuidv7();
  try {
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Upgrade', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Family')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name)
      values (${memberId}, ${gymId}, ${householdId}, 'Test', 'Member')`;
    await maintenance.sql`insert into invoices (id, gym_id, household_id, kind, due_on, amount_cents, currency)
      values (${invoiceId}, ${gymId}, ${householdId}, 'one_off', '2026-11-09', 1000, 'USD')`;
    for (const purpose of ['onboarding', 'pay_invoice', 'update_card', 'sign_waiver']) {
      const id = uuidv7(), hash = id.replaceAll('-', '').repeat(2);
      await maintenance.sql`insert into signed_links (id, gym_id, household_id, token_hash, purpose, invoice_id, member_id, expires_at)
        values (${id}, ${gymId}, ${householdId}, ${hash}, ${purpose},
          ${purpose === 'pay_invoice' ? invoiceId : null}, ${purpose === 'sign_waiver' ? memberId : null}, '2027-01-01Z')`;
    }
    const before = await database.forGym(gymId, tx => tx.select().from(signedLinks).orderBy(signedLinks.id));
    await migrateDatabase(database.maintenanceUrl);
    expect(await database.forGym(gymId, tx => tx.select().from(signedLinks).orderBy(signedLinks.id))).toEqual(before);
    for (const table of [announcements, announcementRecipients, announcementOptOuts])
      expect(await database.forGym(gymId, tx => tx.select().from(table))).toEqual([]);
    await expect(createFactories(database)('signedLinks', gymId, { purpose: 'unsubscribe', householdId, memberId }))
      .resolves.toMatchObject({ purpose: 'unsubscribe', memberId, invoiceId: null });
  } finally { await maintenance.close(); }
});

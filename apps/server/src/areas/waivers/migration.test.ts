// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
// eslint-disable-next-line database/system-tables, no-restricted-imports -- This upgrade fixture seeds historical SQL in its disposable database only.
import { openConnection } from '@plaingym/db/client';
// eslint-disable-next-line database/system-tables -- Exercise the production migration runner against the historical fixture.
import { migrateDatabase } from '@plaingym/db/migrate';
import { useUpgradeTestDatabase } from '@plaingym/db/testing/database-upgrade';
import { FakeUploads } from '../../infra/storage/index.js';
import { TestClock } from '../../core/clock.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from './waivers.js';
import { digest, readSnapshot, serializeSnapshot } from './snapshot.js';

const db = useUpgradeTestDatabase('0022_email_delivery_commands');
it('upgrades populated text templates without changing their immutable signed records', async () => {
  const gymId = uuidv7(), householdId = uuidv7(), memberId = uuidv7(), templateId = uuidv7(), signatureId = uuidv7();
  const clock = new TestClock('2026-11-05T12:00:00Z'), uploads = new FakeUploads(gymId, clock);
  const image = demoSignaturePng(), imageKey = `${gymId}/waivers/${memberId}/signatures/${uuidv7()}.png`, imageHash = digest(image);
  await uploads.put(imageKey, image, 'image/png');
  const template = { id: templateId, name: 'Existing terms', kind: 'waiver' as const, version: 1, body: 'Original text terms.' };
  const snapshot = serializeSnapshot({ template, member: { id: memberId, firstName: 'Existing', lastName: 'Member', dateOfBirth: '1990-01-01' },
    signer: { kind: 'self', name: 'Existing Member' }, signedAt: clock.now().toISOString(), signatureImage: { key: imageKey, hash: imageHash } });
  const maintenance = openConnection(db.maintenanceUrl, 1);
  try {
    // Historical SQL deliberately omits every column introduced by this change.
    await maintenance.sql`insert into gyms (id, name, slug) values (${gymId}, 'Test Gym', ${gymId})`;
    await maintenance.sql`insert into households (id, gym_id, name) values (${householdId}, ${gymId}, 'Existing household')`;
    await maintenance.sql`insert into members (id, gym_id, household_id, first_name, last_name, date_of_birth)
      values (${memberId}, ${gymId}, ${householdId}, 'Existing', 'Member', '1990-01-01')`;
    await maintenance.sql`insert into waiver_templates (id, gym_id, name, kind, version, body)
      values (${templateId}, ${gymId}, ${template.name}, ${template.kind}, ${template.version}, ${template.body})`;
    await maintenance.sql`insert into waiver_signatures (id, gym_id, member_id, template_id, snapshot, snapshot_hash, signature_image_key, signature_image_hash, signed_at, ip_address)
      values (${signatureId}, ${gymId}, ${memberId}, ${templateId}, ${snapshot.snapshot}, ${snapshot.snapshotHash}, ${imageKey}, ${imageHash}, ${clock.now().toISOString()}, 'unknown')`;
  } finally { await maintenance.close(); }
  await migrateDatabase(db.maintenanceUrl);
  const service = createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  expect((await service.listTemplates(gymId)).data).toMatchObject([template]);
  const signed = await service.getSignature(gymId, signatureId);
  expect(signed).toMatchObject(snapshot);
  expect(readSnapshot(signed.snapshot, signed.snapshotHash).template).toEqual(template);
  await expect(service.pdf(gymId, signatureId)).resolves.toMatchObject({ data: { url: expect.any(String) } });
});

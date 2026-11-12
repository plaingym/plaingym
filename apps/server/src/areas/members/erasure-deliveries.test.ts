// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailDeliveries, invoices, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { TestClock } from '../../core/clock.js';
import { commandDigest, FakeEmail, recipientDigest } from '../../infra/email/index.js';
import { announcementDeliveryKey } from '../announcements/send.delivery.js';
import { snapshot } from '../billing/transitions/store.js';
import { createTransitionNotifications } from '../billing/transitions/notifications.js';
import { createGymSettingsAccessor } from '../settings/settings.js';
import { createMembersService } from './members.js';

const db = useTestDatabase(), factory = createFactories(db);
const queue = { jobs: { enqueue: async () => ({ jobId: uuidv7() }) }, timezone: 'UTC' };

describe('erasure and delivery records', () => {
  it('leaves no delivery row holding a value derived from the erased member\'s address', async () => {
    const gymId = uuidv7(), clock = new TestClock('2026-11-12T12:00:00Z'), email = new FakeEmail(), address = 'payer@example.invalid';
    await factory('gyms', gymId, { memberEmailsEnabled: true });
    const household = await factory('households', gymId, { email: address });
    const person = await factory('members', gymId, { householdId: household.id, email: address });
    const other = await factory('members', gymId, { householdId: (await factory('households', gymId, { email: 'other@example.invalid' })).id,
      email: 'other@example.invalid' });
    const invoice = await factory('invoices', gymId, { householdId: household.id, amountCents: 10000, currency: 'USD', status: 'open', number: 1 });
    // A receipt and a dunning notice through the billing notices.
    const notifications = createTransitionNotifications({ scope: db.forGym, clock, settings: createGymSettingsAccessor({ scope: db.forGym }),
      prepare: async () => ({ email, origin: 'https://gym.example.invalid' }), staffRecipients: async () => ['owner@example.invalid'] });
    const [row] = await db.forGym(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, invoice.id)));
    await notifications.receipt({ gymId, generation: uuidv7(), invoice: snapshot(row!) });
    await notifications.dunning({ gymId, generation: uuidv7(), invoice: snapshot(row!), actionRequired: false });
    // An announcement to each member and a cancellation notice, which keep a digest of the address they went to.
    const announcement = await factory('announcements', gymId);
    const digests: Record<string, string> = {};
    for (const member of [person, other]) {
      const recipient = await factory('announcementRecipients', gymId, { announcementId: announcement.id, memberId: member.id });
      digests[member.id] = commandDigest([announcement.id, member.email]);
      await factory('emailDeliveries', gymId, { key: announcementDeliveryKey(announcement.id as string, recipient.id as string), commandDigest: digests[member.id] });
    }
    const sessionId = uuidv7();
    await factory('emailDeliveries', gymId, { key: `schedule-cancel-notice:${sessionId}:${person.id}`, commandDigest: commandDigest([sessionId, address]) });

    await createMembersService({ scope: db.forGym, clock }).eraseMember({ gymId, actor: { kind: 'system' } }, person.id as string, { revision: 1 }, queue);

    const rows = await db.forGym(gymId, tx => tx.select().from(emailDeliveries));
    const derived = [recipientDigest(address), createHash('sha256').update(address).digest('base64url'), digests[person.id]!,
      commandDigest([sessionId, address])];
    for (const delivery of rows)
      for (const value of derived) {
        expect(delivery.key).not.toContain(value);
        expect(delivery.commandDigest ?? '').not.toContain(value);
      }
    // Every record stays, keyed by IDs: only the other member's own digest is left.
    expect(rows).toHaveLength(5);
    expect(rows.flatMap(delivery => delivery.commandDigest ?? [])).toEqual([digests[other.id]]);
  });
});

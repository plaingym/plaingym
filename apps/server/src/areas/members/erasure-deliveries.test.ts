// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { announcementRecipients, announcements, emailDeliveries, invoices, members, uuidv7 } from '@plaingym/db';
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

  it('clears a shared cancellation address even when the key names the other member, with bounded batches and gym isolation', async () => {
    const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-11-12T12:00:00Z');
    await factory('gyms', gymId); await factory('gyms', otherGym);
    const address = 'shared@example.invalid';
    const first = await factory('members', gymId, { email: address });
    const erased = await factory('members', gymId, { email: '\t SHARED@example.invalid\u00a0' });
    const sharedKey = `schedule-cancel-notice:${uuidv7()}:${first.id}`;
    const digest = commandDigest([sharedKey.split(':')[1], address]);
    await factory('emailDeliveries', otherGym, { key: sharedKey, commandDigest: digest });
    // More than one page; both shared and unshared cancellations retain their ID-only history.
    const noticeRows = Array.from({ length: 502 }, (_, i) => {
      const sessionId = uuidv7();
      return { gymId, key: i === 0 ? sharedKey : `schedule-cancel-notice:${sessionId}:${first.id}`,
        commandDigest: i === 0 ? digest : commandDigest([sessionId, i === 501 ? 'unrelated@example.invalid' : address]),
        state: 'accepted', attempts: 1, createdAt: clock.now(), updatedAt: clock.now() };
    });
    await db.forGym(gymId, tx => tx.insert(emailDeliveries).values(noticeRows));
    const user = await factory('authUser', gymId);
    const messages = await db.forGym(gymId, tx => tx.insert(announcements).values(Array.from({ length: 501 }, () => ({
      gymId, sendGeneration: uuidv7(), createdBy: user.id, subject: 'Notice', body: 'Hello', audience: { statuses: ['active' as const], programIds: [] },
    }))).returning({ id: announcements.id }));
    const recipients = await db.forGym(gymId, tx => tx.insert(announcementRecipients).values(messages.map(message => ({
      gymId, announcementId: message.id, memberId: erased.id, state: 'sent', updatedAt: clock.now(),
    }))).returning({ id: announcementRecipients.id, announcementId: announcementRecipients.announcementId }));
    await db.forGym(gymId, tx => tx.insert(emailDeliveries).values(recipients.map(recipient => ({ gymId,
      key: announcementDeliveryKey(recipient.announcementId, recipient.id), commandDigest: commandDigest([recipient.announcementId, address]),
      state: 'accepted', attempts: 1, createdAt: clock.now(), updatedAt: clock.now() }))));
    await createMembersService({ scope: db.forGym, clock }).eraseMember({ gymId, actor: { kind: 'system' } }, erased.id, { revision: 1 }, queue);
    await db.forGym(gymId, tx => tx.update(members).set({ email: 'changed@example.invalid' }).where(eq(members.id, first.id)));
    const rows = await db.forGym(gymId, tx => tx.select().from(emailDeliveries));
    expect(rows).toHaveLength(1003);
    expect(rows.filter(row => row.commandDigest !== null)).toMatchObject([{ commandDigest: noticeRows[501]!.commandDigest }]);
    expect((await db.forGym(otherGym, tx => tx.select().from(emailDeliveries)))[0]!.commandDigest).toBe(digest);
  });
});

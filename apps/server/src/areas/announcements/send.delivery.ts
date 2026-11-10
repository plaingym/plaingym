// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { announcementRecipients, announcements, emailDeliveries, type forGym, type Transaction, writeAudit } from '@plaingym/db';
import { AppError, type Clock, type Translator } from '@plaingym/shared';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createEmailDeliveries, commandDigest } from '../../infra/email/deliveries.js';
import { deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { MemberEmail } from '../../infra/email/member.js';
import { readGymSettings } from '../settings/settings.js';
import { renderAnnouncement } from '../../emails/announcements/send.js';
import { readAudience } from './audience.js';
import { issueUnsubscribeLink } from './unsubscribe.js';

export const announcementDeliveryKey = (announcementId: string, recipientId: string) => `announcement:${announcementId}:${recipientId}`;
type Outcome = { state: 'sent' | 'failed' | 'skipped'; reason: string | null };
export interface AnnouncementDeliveryOptions {
  scope: typeof forGym; clock: Clock; settings: GymSettingsAccessor; t: Translator;
  mail(gymId: string): Promise<{ email: Email; origin: string; gymName: string }>;
}
export function createAnnouncementDelivery(options: AnnouncementDeliveryOptions) {
  const { scope, clock } = options, deliveries = createEmailDeliveries({ scope, clock });
  async function decide(tx: Transaction, gymId: string, recipientId: string, outcome: Outcome) {
    await tx.update(announcementRecipients).set({ ...outcome, updatedAt: clock.now() }).where(eq(announcementRecipients.id, recipientId));
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'announcement.recipient_decided', targetType: 'announcement_recipient',
      targetId: recipientId, after: outcome, occurredAt: clock.now() });
  }
  type Prepared = Awaited<ReturnType<AnnouncementDeliveryOptions['mail']>>;
  async function deliver(gymId: string, announcement: typeof announcements.$inferSelect, recipientId: string, prepared: Prepared) {
    const announcementId = announcement.id;
    // Finish rendering before the last eligibility read. The random credential becomes usable only if reserved below.
    const token = randomBytes(32).toString('base64url');
    const unsubscribe = new URL(`/l/${token}`, prepared.origin).href;
    const content = await renderAnnouncement({ ...announcement, gymName: prepared.gymName, t: options.t, unsubscribe });
    const reservation = await scope(gymId, async tx => {
      // Serialize only reservations, never SMTP. This also protects address deduplication between workers.
      const [locked] = await tx.select({ id: announcements.id }).from(announcements).where(eq(announcements.id, announcementId)).for('update');
      if (!locked) throw new AppError('not_found', 'Announcement not found');
      const [recipient] = await tx.select().from(announcementRecipients)
        .where(and(eq(announcementRecipients.id, recipientId), eq(announcementRecipients.announcementId, announcementId))).for('update');
      if (!recipient || recipient.state !== 'pending') return;
      const key = announcementDeliveryKey(announcementId, recipientId);
      const previous = await deliveries.state(tx, gymId, key);
      if (previous) {
        if (previous === 'sending')
          throw new AppError('conflict', 'Announcement delivery is in flight');
        await decide(tx, gymId, recipientId, { state: previous === 'accepted' ? 'sent' : 'failed',
          reason: previous === 'accepted' ? null : previous === 'not_accepted' ? 'not_accepted' : 'unknown' });
        return;
      }
      const settings = await readGymSettings(tx, gymId);
      if (!settings.memberEmailsEnabled) { await decide(tx, gymId, recipientId, { state: 'skipped', reason: 'disabled' }); return; }
      const audience = await readAudience(tx, announcement.audience, recipient.memberId);
      const candidate = audience.candidates.find(row => row.memberId === recipient.memberId);
      if (!candidate || candidate.reason) {
        await decide(tx, gymId, recipientId, { state: 'skipped', reason: candidate?.reason ?? 'ineligible' }); return;
      }
      // A request digest records the actual normalized destination without storing a readable address in keys or audits.
      // Keep it after every outcome, even a definite failure: this announcement never retries a decided address.
      const digest = commandDigest([announcementId, candidate.address]);
      const [duplicate] = await tx.select({ id: emailDeliveries.id }).from(emailDeliveries)
        .where(and(eq(emailDeliveries.gymId, gymId), eq(emailDeliveries.commandDigest, digest))).limit(1);
      if (duplicate) { await decide(tx, gymId, recipientId, { state: 'skipped', reason: 'duplicate_address' }); return; }
      const reserved = await deliveries.reserve(tx, gymId, key, digest);
      await issueUnsubscribeLink(tx, gymId, recipient.memberId, clock.now(), token);
      return { reserved, memberId: recipient.memberId, address: candidate.address };
    });
    if (!reservation) return;
    const { reserved, memberId, address } = reservation;
    let outcome: Outcome;
    let attempted = false;
    try {
      const message = { ...content, to: address, listUnsubscribe: unsubscribe };
      // The reservation checked the whole address group after rendering. MemberEmail still checks the switch,
      // member's current address and global preferences immediately before calling the transport.
      const guarded = new MemberEmail({ gymId, memberId, email: prepared.email, settings: options.settings, forGym: scope });
      attempted = true;
      const result = await deliveries.attempt(reserved, guarded, message);
      outcome = result.status === 'sent' ? { state: 'sent', reason: null } : { state: 'skipped', reason: result.reason };
    } catch (error) {
      if (!attempted) await deliveries.release(reserved);
      outcome = { state: 'failed', reason: attempted ? deliveryAcceptance(error) : 'not_accepted' };
    }
    await scope(gymId, tx => decide(tx, gymId, recipientId, outcome));
  }
  return {
    async run(gymId: string, announcementId: string) {
      const [announcement] = await scope(gymId, tx => tx.select().from(announcements).where(eq(announcements.id, announcementId)));
      if (!announcement) throw new AppError('not_found', 'Announcement not found');
      let deferred = false;
      let prepared: Prepared | undefined;
      for (;;) {
        const rows = await scope(gymId, tx => tx.select({ id: announcementRecipients.id }).from(announcementRecipients)
          .where(and(eq(announcementRecipients.announcementId, announcementId), eq(announcementRecipients.state, 'pending')))
          .orderBy(asc(announcementRecipients.id)).limit(25));
        if (!rows.length) break;
        // Prepared once per run, before any reservation: a setup failure reserves nothing and the job retry recovers.
        prepared ??= await options.mail(gymId);
        for (const row of rows) {
          try { await deliver(gymId, announcement, row.id, prepared); }
          catch (error) { if (error instanceof AppError && error.code === 'conflict') deferred = true; else throw error; }
        }
        if (deferred) break;
      }
      if (deferred) throw new AppError('conflict', 'Announcement delivery is in flight');
      await scope(gymId, async tx => {
        const [row] = await tx.select().from(announcements).where(eq(announcements.id, announcementId)).for('update');
        if (!row) throw new AppError('not_found', 'Announcement not found');
        const pending = await tx.select({ id: announcementRecipients.id }).from(announcementRecipients)
          .where(and(eq(announcementRecipients.announcementId, announcementId), eq(announcementRecipients.state, 'pending'))).limit(1);
        if (pending.length || row.status === 'sent') return;
        await tx.update(announcements).set({ status: 'sent', completedAt: clock.now() }).where(eq(announcements.id, announcementId));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'announcement.completed', targetType: 'announcement',
          targetId: announcementId, occurredAt: clock.now() });
      });
    },
  };
}

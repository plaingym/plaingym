// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { announcementRecipients, announcements, forGym, staffRoles, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, createTranslator, type Clock } from '@plaingym/shared';
import { announcementDraftSchema, sendAnnouncementSchema, type AnnouncementDraft, type SendAnnouncement } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as systemClock } from '../../core/clock.js';
import { type Email } from '../../infra/email/index.js';
import { withJobTransaction, type Jobs } from '../../infra/jobs/index.js';
import type { SmtpResolver } from '../settings/smtp.js';
import { createGymSettingsAccessor, createSettingsService, readGymSettings } from '../settings/settings.js';
import { renderAnnouncement } from '../../emails/announcements/send.js';
import messages from '../../../../../locales/en/announcements/send.json' with { type: 'json' };
import { readAudience } from './audience.js';
import { createAnnouncementDelivery } from './send.delivery.js';
import { createAnnouncementHistory } from './send.history.js';

export const announcementSendJob = 'announcements.send';
export const announcementPayload = z.object({ announcementId: z.uuid() });
export interface AnnouncementActor { gymId: string; userId: string }
export interface AnnouncementsOptions {
  scope?: typeof forGym; clock?: Clock; jobs: Jobs;
  smtp: Pick<SmtpResolver, 'configured'>;
  mailer(gymId: string): Promise<Email>;
  origin(gymId: string): Promise<string>;
  /** Trusted authentication lookup, never an address supplied by the request body. */
  senderEmail(gymId: string, userId: string): Promise<string>;
  demoMode?: boolean;
  demoEmailFor?(gymId: string): Email;
}
const t = createTranslator({ 'announcements/send': messages });
const refuse = (reason: 'disabled' | 'no_smtp'): never => {
  throw new AppError('conflict', t(reason === 'disabled' ? 'announcements/send:disabled' : 'announcements/send:noSmtp'), { reason: [reason] });
};
export function createAnnouncementsService(options: AnnouncementsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settings = createGymSettingsAccessor({ scope }), gymSettings = createSettingsService({ scope });
  const demo = options.demoMode ?? process.env.DEMO_MODE === 'true';
  async function available(gymId: string) {
    const gym = await settings.get(gymId);
    if (!gym.memberEmailsEnabled) refuse('disabled');
    if (!demo && !await options.smtp.configured(gymId)) refuse('no_smtp');
    if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Announcement demo outbox is not configured');
    return gym;
  }
  async function mail(gymId: string) {
    const origin = new URL(await options.origin(gymId));
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
      throw new AppError('unavailable', 'Announcements require a canonical HTTPS origin');
    const details = await gymSettings.get(gymId);
    if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Announcement demo outbox is not configured');
    const email = demo ? options.demoEmailFor!(gymId) : await options.mailer(gymId);
    return { email, origin: origin.origin, gymName: details.name };
  }
  async function manager(tx: Transaction, actor: AnnouncementActor) {
    const [role] = await tx.select({ id: staffRoles.id }).from(staffRoles)
      .where(and(eq(staffRoles.userId, actor.userId), inArray(staffRoles.role, ['owner', 'admin'])));
    if (!role) throw new AppError('forbidden', 'Announcement permission required');
  }
  const history = createAnnouncementHistory(scope);
  const delivery = createAnnouncementDelivery({ scope, clock, settings, t, mail });
  return {
    ...history,
    async preview(gymId: string, input: AnnouncementDraft) {
      const draft = announcementDraftSchema.parse(input);
      await available(gymId);
      return scope(gymId, async tx => ({ recipientCount: (await readAudience(tx, draft.audience)).recipients.length }));
    },
    async test(actor: AnnouncementActor, input: AnnouncementDraft) {
      const draft = announcementDraftSchema.parse(input);
      // Staff test mail uses the unwrapped transport, even when member email is disabled.
      if (!demo && !await options.smtp.configured(actor.gymId)) refuse('no_smtp');
      await scope(actor.gymId, tx => manager(tx, actor));
      const address = z.email().parse(await options.senderEmail(actor.gymId, actor.userId));
      const prepared = await mail(actor.gymId);
      await scope(actor.gymId, tx => writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId,
        action: 'announcement.test_requested', targetType: 'user', targetId: actor.userId, occurredAt: clock.now() }));
      try {
        const result = await prepared.email.sendEmail({ to: address, ...renderAnnouncement({ ...draft, gymName: prepared.gymName, t }) });
        if (result.status !== 'sent') throw new Error('Suppressed');
      } catch { throw new AppError('unavailable', t('announcements/send:failed')); }
      return { sent: true as const };
    },
    async send(actor: AnnouncementActor, input: SendAnnouncement) {
      const draft = sendAnnouncementSchema.parse(input);
      const gym = await available(actor.gymId);
      const id = draft.sendGeneration.toLowerCase();
      await withJobTransaction(scope, actor.gymId, async transaction => {
        const { tx } = transaction;
        await manager(tx, actor);
        if (!(await readGymSettings(tx, actor.gymId)).memberEmailsEnabled) refuse('disabled');
        const [row] = await tx.insert(announcements).values({ id, gymId: actor.gymId, createdBy: actor.userId,
          subject: draft.subject, body: draft.body, audience: draft.audience, createdAt: clock.now() })
          .onConflictDoNothing().returning();
        if (!row) {
          const [previous] = await tx.select().from(announcements).where(eq(announcements.id, id));
          if (!previous || previous.createdBy !== actor.userId || previous.subject !== draft.subject || previous.body !== draft.body
            || JSON.stringify(previous.audience.statuses) !== JSON.stringify(draft.audience.statuses)
            || JSON.stringify(previous.audience.programIds) !== JSON.stringify(draft.audience.programIds))
            throw new AppError('conflict', 'This send generation belongs to another announcement');
          return;
        }
        const { recipients } = await readAudience(tx, draft.audience);
        for (let offset = 0; offset < recipients.length; offset += 100) await tx.insert(announcementRecipients)
          .values(recipients.slice(offset, offset + 100).map(recipient => ({ gymId: actor.gymId, announcementId: id,
            memberId: recipient.memberId, createdAt: clock.now(), updatedAt: clock.now() })));
        await tx.update(announcements).set({ recipientCount: recipients.length }).where(eq(announcements.id, id));
        await writeAudit(tx, { gymId: actor.gymId, actorKind: 'user', actorUserId: actor.userId, action: 'announcement.queued',
          targetType: 'announcement', targetId: id, after: { recipientCount: recipients.length }, occurredAt: clock.now() });
        await options.jobs.enqueue(announcementSendJob, { announcementId: id }, {
          gymId: actor.gymId, timezone: gym.timezone, idempotencyKey: id, maxAttempts: 12,
        }, transaction);
      });
      return history.get(actor.gymId, id);
    },
    async run(payload: unknown, gymId: string) { await delivery.run(gymId, announcementPayload.parse(payload).announcementId); },
  };
}
export type AnnouncementsService = ReturnType<typeof createAnnouncementsService>;
let configured: AnnouncementsService | undefined;
export function configureAnnouncements(service: AnnouncementsService) { configured = service; }
export function announcementService(): AnnouncementsService {
  const unavailable = (): never => { throw new AppError('unavailable', 'Announcement delivery is not configured'); };
  return configured ?? { ...createAnnouncementHistory(), preview: unavailable, test: unavailable, send: unavailable, run: unavailable };
}

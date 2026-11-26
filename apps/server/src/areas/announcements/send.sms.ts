// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { announcementSmsRecipients as recipients, announcements, smsDeliveries, writeAudit, type forGym, type Transaction } from '@plaingym/db';
import { announcementSmsBody, announcementSmsText, AppError, type Clock } from '@plaingym/shared';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { withJobTransaction, type Jobs } from '../../infra/jobs/index.js';
import { createSmsDeliveries, deliveryAcceptance, DeliveryError, MemberSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { noticeCapSettings } from '../bookings/bookings.sms.js';
import { holdGymSettings, readGymSettings } from '../settings/settings.js';
import type { ResolvedSms, SmsResolver } from '../settings/sms.js';
import { logError } from '../../core/log.js';
import { readSmsAudience } from './audience.js';

export const announcementSmsJob = 'announcements.send-sms';
export const announcementSmsKey = (id: string, recipientId: string) => `announcement-sms:${id}:${recipientId}`;
export const announcementSmsJobKey = (id: string, scheduledFor: Date | null) => scheduledFor ? `${id}:${scheduledFor.getTime()}` : id;
/** Compare instants made by the shared wall-time conversion, including both daylight-saving transitions. */
export function nextAnnouncementSmsTime(now: Date, timezone: string): Date | null {
  const day = localDate(now, timezone);
  const start = zonedInstant(day, '08:00', timezone, { gap: 'shift' })!;
  const end = zonedInstant(day, '21:00', timezone, { gap: 'shift' })!;
  return now < start ? start : now < end ? null : zonedInstant(addDays(day, 1), '08:00', timezone, { gap: 'shift' })!;
}
export interface AnnouncementSmsOptions {
  resolver: SmsResolver;
  phoneDigest(phone: string): string;
}
export function checkedAnnouncementSms(name: string, body: string): string {
  const text = announcementSmsBody(name, body);
  if (text.length > 480) throw new AppError('invalid_request', 'Announcement text including the gym name and STOP line must be at most 480 characters', { sms: ['too_long'] });
  return text;
}
type Outcome = { state: 'sent' | 'failed' | 'skipped'; reason: string | null };
export function createAnnouncementSmsDelivery(options: {
  scope: typeof forGym; clock: Clock; jobs: Jobs; settings: GymSettingsAccessor; sms?: AnnouncementSmsOptions;
}) {
  const { scope, clock, settings } = options, deliveries = createSmsDeliveries({ scope, clock });
  async function totals(tx: Transaction, id: string): Promise<boolean> {
    const rows = await tx.select({ state: recipients.state, count: count() }).from(recipients)
      .where(eq(recipients.announcementId, id)).groupBy(recipients.state);
    const total = (state: string) => rows.find(row => row.state === state)?.count ?? 0;
    const done = !total('pending');
    await tx.update(announcements).set({ smsSent: total('sent'), smsFailed: total('failed'), smsSkipped: total('skipped'),
      ...(done ? { smsCompletedAt: clock.now(), smsScheduledFor: null } : {}) }).where(eq(announcements.id, id));
    return done;
  }
  async function flush(gymId: string, id: string) {
    await scope(gymId, async tx => {
      await tx.select({ id: announcements.id }).from(announcements).where(eq(announcements.id, id)).for('update');
      await totals(tx, id);
    });
  }
  async function decide(tx: Transaction, gymId: string, row: typeof recipients.$inferSelect, outcome: Outcome) {
    await tx.update(recipients).set({ ...outcome, updatedAt: clock.now() }).where(eq(recipients.id, row.id));
    await writeAudit(tx, { gymId, actorKind: 'system', action: 'announcement.sms_recipient_decided', targetType: 'announcement_sms_recipient',
      targetId: row.id, after: outcome, occurredAt: clock.now() });
  }
  async function defer(gymId: string, id: string, timezone: string, runAt: Date) {
    await withJobTransaction(scope, gymId, async transaction => {
      const [row] = await transaction.tx.select().from(announcements).where(eq(announcements.id, id)).for('update');
      if (!row || row.smsCompletedAt) return;
      // Writes the page's counts; with no pending row left the text send completes instead of deferring.
      if (await totals(transaction.tx, id)) return;
      await transaction.tx.update(announcements).set({ smsScheduledFor: runAt }).where(eq(announcements.id, id));
      await options.jobs.enqueue(announcementSmsJob, { announcementId: id }, { gymId, timezone, runAt,
        idempotencyKey: announcementSmsJobKey(id, runAt), maxAttempts: 12 }, transaction);
      await writeAudit(transaction.tx, { gymId, actorKind: 'system', action: 'announcement.sms_deferred', targetType: 'announcement',
        targetId: id, after: { runAt: runAt.toISOString() }, occurredAt: clock.now() });
    });
  }
  return {
    async run(gymId: string, id: string) {
      const [announcement] = await scope(gymId, tx => tx.select().from(announcements).where(eq(announcements.id, id)));
      if (!announcement) throw new AppError('not_found', 'Announcement not found');
      if (!announcement.smsBody || announcement.smsCompletedAt) return;
      if (!options.sms) throw new AppError('unavailable', 'Announcement text delivery is not configured');
      const sms = options.sms;
      for (;;) {
        const gym = await settings.get(gymId), runAt = nextAnnouncementSmsTime(clock.now(), gym.timezone);
        if (runAt) { await defer(gymId, id, gym.timezone, runAt); return; }
        const rows = await scope(gymId, tx => tx.select().from(recipients).where(and(eq(recipients.announcementId, id), eq(recipients.state, 'pending')))
          .orderBy(asc(recipients.id)).limit(25));
        if (!rows.length) {
          await flush(gymId, id);
          return;
        }
        // A resolver error fails each row's send (through `MemberSms`) instead of the job.
        const resolution: { value: ResolvedSms | null } | { error: unknown } = await sms.resolver.resolve(gymId)
          .then(value => ({ value }), (error: unknown) => {
            // MemberSms replaces the cause with a generic non-send, so name it here.
            logError('announcements.sms_provider_unresolved', { gymId, announcementId: id }, error);
            return { error };
          });
        // A page that starts with texts off or no provider reads both per row, so turning texts on mid-page sends the rest.
        const live = !gym.memberSmsEnabled || ('value' in resolution && !resolution.value);
        const pageSettings: GymSettingsAccessor = live ? settings : { get: async () => gym };
        const resolveProvider = async (): Promise<ResolvedSms | null> => {
          if (live) return sms.resolver.resolve(gymId);
          if ('error' in resolution) throw resolution.error;
          return resolution.value;
        };
        try {
          for (const snapshot of rows) {
            const next = nextAnnouncementSmsTime(clock.now(), gym.timezone);
            if (next) { await defer(gymId, id, gym.timezone, next); return; }
            const reservation = await scope(gymId, async tx => {
              await tx.select({ id: announcements.id }).from(announcements).where(eq(announcements.id, id)).for('update');
              const [row] = await tx.select().from(recipients).where(eq(recipients.id, snapshot.id)).for('update');
              if (!row || row.state !== 'pending') return;
              const legacyKey = announcementSmsKey(id, row.memberId), recipientKey = announcementSmsKey(id, row.id);
              const priorRows = await tx.select({ key: smsDeliveries.key, state: smsDeliveries.state, updatedAt: smsDeliveries.updatedAt })
                .from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId), inArray(smsDeliveries.key, [legacyKey, recipientKey])));
              const previous = priorRows.find(delivery => delivery.key === legacyKey) ?? priorRows[0];
              const key = previous?.key ?? recipientKey;
              if (previous?.state === 'sending' && previous.updatedAt.getTime() > clock.now().getTime() - smsInFlightMs)
                throw new AppError('conflict', 'Announcement text is in flight');
              if (previous && previous.state !== 'not_accepted') {
                await decide(tx, gymId, row, { state: previous.state === 'accepted' ? 'sent' : 'failed', reason: previous.state === 'accepted' ? null : 'unknown' }); return;
              }
              const groups = await readSmsAudience(tx, announcement.audience, gym.country, { memberIds: row.memberIds });
              const group = groups.find(group => sms.phoneDigest(group.phone) === row.phoneDigest);
              if (!group) { await decide(tx, gymId, row, { state: 'skipped', reason: 'ineligible' }); return; }
              const digest = `announcement-sms:${id}:${row.phoneDigest}`;
              // A definite non-send can retry after erasure without restoring a cleared digest.
              const reserved = previous ? await deliveries.reserve(tx, gymId, key) : await deliveries.reserve(tx, gymId, key, digest);
              if (reserved) return { row, group, reserved };
            });
            if (!reservation) continue;
            let quiet: { runAt: Date; timezone: string } | undefined;
            let lockedTimezone = gym.timezone;
            // Check the clock at the final transport boundary too: the moment after the cap transaction commits can cross 21:00.
            const resolver: SmsResolver = { ...sms.resolver, async resolve() {
              const resolved = await resolveProvider();
              return resolved && { ...resolved, sms: { verifyAccount: () => resolved.sms.verifyAccount(), async sendSms(message) {
                const at = nextAnnouncementSmsTime(clock.now(), lockedTimezone);
                if (at) { quiet = { runAt: at, timezone: lockedTimezone }; throw new DeliveryError('not_accepted', 'Quiet hours'); }
                if (message.body.length > 480) throw new DeliveryError('not_accepted', 'Announcement text is too long');
                return resolved.sms.sendSms(message);
              } } };
            } };
            const guarded = new MemberSms({
              gymId, memberIds: reservation.group.memberIds, householdIds: [], kind: 'announcements',
              resolver, settings: pageSettings, scope, clock,
              recheck: async tx => {
                await holdGymSettings(tx, gymId);
                const locked = await readGymSettings(tx, gymId);
                const at = nextAnnouncementSmsTime(clock.now(), locked.timezone);
                if (at) { quiet = { runAt: at, timezone: locked.timezone }; throw new DeliveryError('not_accepted', 'Quiet hours'); }
                lockedTimezone = locked.timezone;
                return noticeCapSettings(locked);
              },
            });
            let outcome: Outcome;
            try {
              const result = await deliveries.attempt(reservation.reserved, guarded, { to: reservation.group.phone, body: announcementSmsText(announcement.smsBody) });
              outcome = result.status === 'sent' ? { state: 'sent', reason: null } : { state: 'skipped', reason: result.reason };
            } catch (error) { outcome = { state: 'failed', reason: deliveryAcceptance(error) }; }
            if (quiet) { await defer(gymId, id, quiet.timezone, quiet.runAt); return; }
            await scope(gymId, async tx => {
              await tx.select({ id: announcements.id }).from(announcements).where(eq(announcements.id, id)).for('update');
              await decide(tx, gymId, reservation.row, outcome);
            });
          }
        } catch (error) {
          // Counts follow the rows decided before the throw; the original error still fails the job.
          await flush(gymId, id).catch((flushError: unknown) => logError('announcements.sms_flush_failed', { gymId, announcementId: id }, flushError));
          throw error;
        }
        await flush(gymId, id);
      }
    },
  };
}

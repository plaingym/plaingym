// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNotNull, isNull, like, ne, or } from 'drizzle-orm';
import { classSessions, members, smsDeliveries } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { createSmsDeliveries, type Sms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { noticeSender, noticeWhen, readNoticePhones, type ClassNoticeDeliveryOptions } from '../bookings/bookings.sms.js';
import messages from '../../../../../locales/en/announcements/cancellation.json' with { type: 'json' };

interface Cancellation { sessionId: string; memberIds: string[] }
export const cancellationSmsKeyPrefix = 'schedule-cancel-sms:';

/** A separate keyed send after email; neither channel's suppression nor outcome decides the other. */
export function createCancellationSms(options: ClassNoticeDeliveryOptions) {
  const { scope, clock, settings } = options, deliveries = createSmsDeliveries(options);
  const t = createTranslator({ 'announcements/cancellation': messages });
  return {
    async run(notice: Cancellation, gymId: string) {
      if (!options.sms) return;
      const { memberSmsEnabled, timezone } = await settings.get(gymId);
      if (!memberSmsEnabled) return;
      const groups = await scope(gymId, tx => readNoticePhones(tx, gymId, notice.memberIds));
      const prefix = `${cancellationSmsKeyPrefix}${notice.sessionId}:`;
      const keyFor = (memberId: string) => prefix + memberId;
      const owned = new Set(groups.map(group => keyFor(group.memberIds[0]!)));
      let failure: unknown;
      for (const group of groups) {
        try {
          const reservation = await scope(gymId, async tx => {
            // Erasure locks the member before clearing the ledger. Keep that order, even when no booking remains.
            const anchor = group.memberIds[0]!;
            const [member] = await tx.select({ id: members.id }).from(members)
              .where(and(eq(members.id, anchor), isNull(members.anonymizedAt))).for('share');
            if (!member) throw new AppError('conflict', 'Cancellation text recipients changed');
            // Serializes key/destination reservations only; the provider is always outside this transaction.
            const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
            if (!session || session.status !== 'cancelled') return;
            const current = (await readNoticePhones(tx, gymId, group.memberIds)).find(row => row.phoneE164 === group.phoneE164);
            if (!current) return;
            if (current.memberIds[0] !== anchor) throw new AppError('conflict', 'Cancellation text recipients changed');
            const key = keyFor(anchor);
            const digest = prefix + options.sms!.phoneDigest(current.phoneE164);
            const previous = await tx.select().from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId),
              or(eq(smsDeliveries.key, key), eq(smsDeliveries.commandDigest, digest),
                and(like(smsDeliveries.key, prefix + '%'), isNull(smsDeliveries.commandDigest), ne(smsDeliveries.state, 'not_accepted')))));
            // After erasure, match the covered IDs instead of restoring a digest. An older redacted row
            // without a group snapshot can only prove that a destination in the original roster was covered.
            const matching = previous.filter(row => {
              if (row.key === key || row.commandDigest === digest) return true;
              if (owned.has(row.key)) return false;
              const snapshot = row.commandResult as { memberIds: string[] } | null;
              return snapshot ? snapshot.memberIds.some(id => current.memberIds.includes(id))
                : notice.memberIds.includes(row.key.slice(prefix.length));
            });
            if (matching.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - smsInFlightMs))
              throw new AppError('conflict', 'Cancellation text is in flight');
            if (matching.some(row => row.state !== 'not_accepted')) return;
            // A definite non-send can be retried, including after the first member in an address group changes. Prefer
            // this group's own key, and never take over a key that another job-start phone group owns.
            const retry = matching.find(row => row.key === key) ?? matching.find(row => !owned.has(row.key));
            const [updated] = retry ? await tx.update(smsDeliveries).set({ commandDigest: digest }).where(and(eq(smsDeliveries.id, retry.id),
              isNotNull(smsDeliveries.commandDigest))).returning({ key: smsDeliveries.key }) : [];
            const reserved = await deliveries.reserve(tx, gymId, updated?.key ?? key, digest);
            await deliveries.remember(tx, reserved, { memberIds: current.memberIds });
            return { reserved, session, memberIds: current.memberIds };
          });
          if (!reservation) continue;
          const guarded: Sms = {
            verifyAccount: () => noticeSender(options, gymId, group).verifyAccount(),
            async sendSms() {
              const current = await scope(gymId, async tx => {
                const [session] = await tx.select({ status: classSessions.status }).from(classSessions).where(eq(classSessions.id, notice.sessionId));
                return session?.status === 'cancelled'
                  ? (await readNoticePhones(tx, gymId, reservation.memberIds)).find(row => row.phoneE164 === group.phoneE164) : undefined;
              });
              if (!current) return { status: 'suppressed', reason: 'no_consent' };
              // A member's own consented phone covering only them isn't told their own name. A household billing
              // phone is marked by its consent household, and always lists who it covers.
              const self = current.memberIds.length === 1 && !current.consentHouseholdIds.length
                && current.consentMemberIds.length === 1 && current.consentMemberIds[0] === current.memberIds[0];
              // Format all texts in the job's timezone. MemberSms still reloads the send settings.
              return noticeSender(options, gymId, current).sendSms({ to: current.phoneE164,
                body: t(self ? 'announcements/cancellation:sms_self' : 'announcements/cancellation:sms', { name: reservation.session.name,
                  ...noticeWhen(reservation.session.startsAt, timezone), names: current.memberNames.join(', ') }) });
            },
          };
          await deliveries.attempt(reservation.reserved, guarded, { to: group.phoneE164, body: '' });
        } catch (error) { failure ??= error; }
      }
      // A failed phone must not strand the rest of the roster. Unknown reservations never send again on retry.
      if (failure) throw failure;
    },
  };
}

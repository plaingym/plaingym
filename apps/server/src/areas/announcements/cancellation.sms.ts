// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, or } from 'drizzle-orm';
import { classSessions, smsDeliveries } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { createSmsDeliveries, type Sms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { noticeSender, noticeWhen, readNoticePhones, type ClassNoticeDeliveryOptions } from '../bookings/bookings.sms.js';
import messages from '../../../../../locales/en/announcements/cancellation.json' with { type: 'json' };

interface Cancellation { sessionId: string; memberIds: string[] }
/** A separate keyed send after email; neither channel's suppression nor outcome decides the other. */
export function createCancellationSms(options: ClassNoticeDeliveryOptions) {
  const { scope, clock, settings } = options, deliveries = createSmsDeliveries(options);
  const t = createTranslator({ 'announcements/cancellation': messages });
  return {
    async run(notice: Cancellation, gymId: string) {
      if (!options.sms || !(await settings.get(gymId)).memberSmsEnabled) return;
      const groups = await scope(gymId, tx => readNoticePhones(tx, gymId, notice.memberIds));
      let failure: unknown;
      for (const group of groups) {
        try {
          const reservation = await scope(gymId, async tx => {
            // Serializes key/destination reservations only; the provider is always outside this transaction.
            const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
            if (!session || session.status !== 'cancelled') return;
            const groups = await readNoticePhones(tx, gymId, notice.memberIds);
            const current = groups.find(row => row.phoneE164 === group.phoneE164);
            if (!current) return;
            const keyFor = (memberId: string) => `schedule-cancel-sms:${notice.sessionId}:${memberId}`;
            const key = keyFor(current.memberIds[0]!);
            const digest = `schedule-cancel-sms:${notice.sessionId}:${options.sms!.phoneDigest(current.phoneE164)}`;
            const previous = await tx.select().from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId),
              or(eq(smsDeliveries.key, key), eq(smsDeliveries.commandDigest, digest))));
            if (previous.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - smsInFlightMs))
              throw new AppError('conflict', 'Cancellation text is in flight');
            if (previous.some(row => row.state !== 'not_accepted')) return;
            // A definite non-send can be retried, including after the first member in an address group changes. Prefer
            // this group's own key, and never take over a key that another current phone group now owns.
            const owned = new Set(groups.filter(row => row !== current).map(row => keyFor(row.memberIds[0]!)));
            const retry = previous.find(row => row.key === key) ?? previous.find(row => !owned.has(row.key));
            if (retry) await tx.update(smsDeliveries).set({ commandDigest: digest }).where(eq(smsDeliveries.id, retry.id));
            const reserved = await deliveries.reserve(tx, gymId, retry?.key ?? key, digest);
            return { reserved, session };
          });
          if (!reservation) continue;
          const guarded: Sms = {
            verifyAccount: () => noticeSender(options, gymId, group).verifyAccount(),
            async sendSms() {
              const current = await scope(gymId, async tx => {
                const [session] = await tx.select({ status: classSessions.status }).from(classSessions).where(eq(classSessions.id, notice.sessionId));
                return session?.status === 'cancelled'
                  ? (await readNoticePhones(tx, gymId, notice.memberIds)).find(row => row.phoneE164 === group.phoneE164) : undefined;
              });
              if (!current) return { status: 'suppressed', reason: 'no_consent' };
              const gym = await settings.get(gymId);
              return noticeSender(options, gymId, current).sendSms({ to: current.phoneE164,
                body: t('announcements/cancellation:sms', { name: reservation.session.name,
                  ...noticeWhen(reservation.session.startsAt, gym.timezone), names: current.memberNames.join(', ') }) });
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

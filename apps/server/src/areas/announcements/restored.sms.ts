// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNotNull, isNull, like, ne, or } from 'drizzle-orm';
import { classBookings, classSessions, members, smsDeliveries, type Transaction } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { createSmsDeliveries, DeliveryError, type MemberSmsOptions, type Sms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { holdGymSettings, readGymSettings } from '../settings/settings.js';
import { memberNoticePhones } from '../members/sms-recipients.js';
import { noticeCapSettings, noticeSender, noticeWhen, readNoticePhones, shareNoticeRecipients, type ClassNoticeDeliveryOptions } from '../bookings/bookings.sms.js';
import { selfNotice } from './cancellation.sms.js';
import messages from '../../../../../locales/en/announcements/restored.json' with { type: 'json' };

interface Restore { sessionId: string; memberIds: string[]; round: number }
export const restoreSmsKeyPrefix = 'schedule-restore-sms:';
/** Every key and digest of one restore's notice is scoped to `<session ID>.<restore count>`. */
export const restoreScope = (notice: Pick<Restore, 'sessionId' | 'round'>) => `${notice.sessionId}.${notice.round}`;

type SessionState = Pick<typeof classSessions.$inferSelect, 'status' | 'restoreCount' | 'startsAt'>;
/** The restore still holds: the session is scheduled, not restored again or cancelled since, and hasn't started. */
export function restoreHolds(session: SessionState | undefined, round: number, now: Date) {
  return session?.status === 'scheduled' && session.restoreCount === round && session.startsAt > now;
}
/** Only members who still have a booked or waitlisted place in the session are told it is back on. */
export async function activeMembers(tx: Transaction, sessionId: string, memberIds: readonly string[]) {
  if (!memberIds.length) return [];
  const rows = await tx.selectDistinct({ memberId: classBookings.memberId }).from(classBookings).where(and(
    eq(classBookings.sessionId, sessionId), inArray(classBookings.status, ['booked', 'waitlisted']),
    inArray(classBookings.memberId, [...memberIds]))).orderBy(asc(classBookings.memberId));
  return rows.map(row => row.memberId);
}

/** A separate keyed send after email; neither channel's suppression nor outcome decides the other. */
export function createRestoreSms(options: ClassNoticeDeliveryOptions) {
  const { scope, clock, settings } = options, deliveries = createSmsDeliveries(options);
  const t = createTranslator({ 'announcements/restored': messages });
  async function phones(tx: Transaction, gymId: string, notice: Restore, memberIds: readonly string[]) {
    return readNoticePhones(tx, gymId, await activeMembers(tx, notice.sessionId, memberIds));
  }
  return {
    async run(notice: Restore, gymId: string) {
      if (!options.sms) return;
      const { memberSmsEnabled, timezone } = await settings.get(gymId);
      if (!memberSmsEnabled) return;
      const groups = await scope(gymId, async tx => {
        const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId));
        return restoreHolds(session, notice.round, clock.now()) ? phones(tx, gymId, notice, notice.memberIds) : [];
      });
      const prefix = `${restoreSmsKeyPrefix}${restoreScope(notice)}:`;
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
            if (!member) throw new AppError('conflict', 'Restore text recipients changed');
            // Serializes key/destination reservations only; the provider is always outside this transaction.
            const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId)).for('update');
            if (!restoreHolds(session, notice.round, clock.now())) return;
            const current = (await phones(tx, gymId, notice, group.memberIds)).find(row => row.phoneE164 === group.phoneE164);
            if (!current) return;
            if (current.memberIds[0] !== anchor) throw new AppError('conflict', 'Restore text recipients changed');
            const key = keyFor(anchor);
            const digest = prefix + options.sms!.phoneDigest(current.phoneE164);
            const previous = await tx.select().from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId),
              or(eq(smsDeliveries.key, key), eq(smsDeliveries.commandDigest, digest),
                and(like(smsDeliveries.key, prefix + '%'), isNull(smsDeliveries.commandDigest), ne(smsDeliveries.state, 'not_accepted')))));
            // After erasure, match the covered IDs instead of restoring a digest.
            const matching = previous.filter(row => {
              if (row.key === key || row.commandDigest === digest) return true;
              if (owned.has(row.key)) return false;
              const snapshot = row.commandResult as { memberIds: string[] } | null;
              return snapshot ? snapshot.memberIds.some(id => current.memberIds.includes(id))
                : notice.memberIds.includes(row.key.slice(prefix.length));
            });
            if (matching.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - smsInFlightMs))
              throw new AppError('conflict', 'Restore text is in flight');
            if (matching.some(row => row.state !== 'not_accepted')) return;
            // A definite non-send can be retried; never take over a key that another job-start phone group owns.
            const retry = matching.find(row => row.key === key) ?? matching.find(row => !owned.has(row.key));
            const [updated] = retry ? await tx.update(smsDeliveries).set({ commandDigest: digest }).where(and(eq(smsDeliveries.id, retry.id),
              isNotNull(smsDeliveries.commandDigest))).returning({ key: smsDeliveries.key }) : [];
            const reserved = await deliveries.reserve(tx, gymId, updated?.key ?? key, digest);
            await deliveries.remember(tx, reserved, { memberIds: current.memberIds });
            return { reserved, session: session!, memberIds: current.memberIds };
          });
          if (!reservation) continue;
          const guarded: Sms = {
            verifyAccount: () => noticeSender(options, gymId, group).verifyAccount(),
            async sendSms() {
              const current = await scope(gymId, async tx => {
                const [session] = await tx.select().from(classSessions).where(eq(classSessions.id, notice.sessionId));
                return restoreHolds(session, notice.round, clock.now())
                  ? (await phones(tx, gymId, notice, reservation.memberIds)).find(row => row.phoneE164 === group.phoneE164) : undefined;
              });
              if (!current) return { status: 'suppressed', reason: 'no_consent' };
              const bodyFor = (self: boolean, names: readonly string[] = current.memberNames) => t(self ? 'announcements/restored:sms_self' : 'announcements/restored:sms', {
                name: reservation.session.name, ...noticeWhen(reservation.session.startsAt, timezone), names: names.join(', '),
              });
              let moved = false;
              // Lock order matches promotion and cancellation texts: settings key share, session FOR SHARE,
              // then reserved members and their households FOR SHARE NOWAIT so a busy row rolls back and retries.
              const lastCheck: NonNullable<MemberSmsOptions['recheck']> = async tx => {
                moved = false;
                await holdGymSettings(tx, gymId);
                const gym = await readGymSettings(tx, gymId);
                const [session] = await tx.select({ status: classSessions.status, restoreCount: classSessions.restoreCount, startsAt: classSessions.startsAt })
                  .from(classSessions).where(and(eq(classSessions.gymId, gymId), eq(classSessions.id, notice.sessionId))).for('share');
                if (!restoreHolds(session, notice.round, clock.now())) return 'no_consent';
                if (!(await shareNoticeRecipients(tx, gymId, reservation.memberIds))) return 'no_consent';
                const active = await activeMembers(tx, notice.sessionId, reservation.memberIds);
                const currentGroups = await memberNoticePhones(tx, gymId, active);
                const now = currentGroups.find(row => row.phoneE164 === group.phoneE164);
                if (currentGroups.some(row => row.phoneE164 !== group.phoneE164 && row.memberIds.some(id => current.memberIds.includes(id)))) {
                  moved = true;
                  return 'phone_changed';
                }
                if (!now || !now.memberIds.length || now.memberIds.some(id => !current.memberIds.includes(id))) return 'no_consent';
                return {
                  ...noticeCapSettings(gym),
                  memberIds: now.memberIds,
                  householdIds: now.consentHouseholdIds,
                  body: bodyFor(selfNotice(now), now.memberIds.map(id => current.memberNames[current.memberIds.indexOf(id)]!)),
                };
              };
              // Format all texts in the job's timezone. The last check locks the send settings and recipient.
              const result = await noticeSender(options, gymId, current, lastCheck).sendSms({ to: current.phoneE164, body: bodyFor(selfNotice(current)) });
              if (moved) throw new DeliveryError('not_accepted', 'Restore text recipients moved');
              return result;
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

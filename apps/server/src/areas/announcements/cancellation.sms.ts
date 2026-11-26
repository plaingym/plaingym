// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNotNull, isNull, like, ne, or } from 'drizzle-orm';
import { classSessions, members, smsDeliveries } from '@plaingym/db';
import { AppError, createTranslator } from '@plaingym/shared';
import { createSmsDeliveries, DeliveryError, onceResolver, type MemberSmsOptions, type Sms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { holdGymSettings, readGymSettings } from '../settings/settings.js';
import { memberNoticePhones } from '../members/sms-recipients.js';
import { noticeCapSettings, noticeSender, noticeWhen, readNoticePhones, shareNoticeRecipients, type ClassNoticeDeliveryOptions } from '../bookings/bookings.sms.js';
import messages from '../../../../../locales/en/announcements/cancellation.json' with { type: 'json' };

interface Cancellation { sessionId: string; memberIds: string[]; round?: number | undefined }
export const cancellationSmsKeyPrefix = 'schedule-cancel-sms:';
/**
 * A session's notices are keyed by its ID until it is restored. After its Nth restore, the next cancellation's
 * notices use `<session ID>.<N>`, so they never collide with an earlier cancellation's deliveries.
 */
export const noticeScope = (sessionId: string, round?: number) => round ? `${sessionId}.${round}` : sessionId;
/**
 * A member's own consented phone covering only them isn't told their own name. A household billing
 * phone is marked by its consent household, and always lists who it covers.
 */
export function selfNotice(group: {
  memberIds: readonly string[]; consentMemberIds: readonly string[]; consentHouseholdIds: readonly string[];
}): boolean {
  return group.memberIds.length === 1 && !group.consentHouseholdIds.length
    && group.consentMemberIds.length === 1 && group.consentMemberIds[0] === group.memberIds[0];
}

type NoticeRow = Pick<typeof smsDeliveries.$inferSelect, 'key' | 'state' | 'commandResult'>;
/** The members a class notice text row covers: its reserved group, or after a narrowed accepted send, who it named. */
export const coveredMembers = (row: Pick<NoticeRow, 'commandResult'>) => (row.commandResult as { memberIds: string[] } | null)?.memberIds;
/** The member key a class notice text key belongs to, without a regrouped `.<n>` suffix. */
export const memberKey = (key: string) => key.replace(/\.\d+$/, '');
/**
 * A phone group's text is keyed by its first member. When an accepted text under that key left the member out (its
 * last check narrowed the group), the member's own later group takes `<key>.<n>`, the smallest n of 2 or more that no
 * such text holds. `previous` must include the rows keyed `<key>.%`.
 */
export function groupKey(previous: readonly NoticeRow[], base: string, anchor: string): string {
  const passedOver = (key: string) => previous.some(row => row.key === key && row.state === 'accepted'
    && coveredMembers(row)?.includes(anchor) === false);
  let key = base;
  for (let n = 2; passedOver(key); n++) key = `${base}.${n}`;
  return key;
}
/** A narrowed accepted text records the members it named, so a member it left out gets a key of their own on a retry. */
export async function recordCovered(scope: ClassNoticeDeliveryOptions['scope'], gymId: string, id: string,
  reserved: readonly string[], covered: readonly string[] | undefined): Promise<void> {
  if (!covered || (covered.length === reserved.length && covered.every(memberId => reserved.includes(memberId)))) return;
  await scope(gymId, tx => tx.update(smsDeliveries).set({ commandResult: { memberIds: [...covered] } })
    .where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.id, id), eq(smsDeliveries.state, 'accepted'))));
}

/** A separate keyed send after email; neither channel's suppression nor outcome decides the other. */
export function createCancellationSms(options: ClassNoticeDeliveryOptions) {
  const { scope, clock, settings } = options, deliveries = createSmsDeliveries(options);
  const t = createTranslator({ 'announcements/cancellation': messages });
  return {
    async run(notice: Cancellation, gymId: string) {
      if (!options.sms) return;
      const snapshot = await settings.get(gymId);
      const { memberSmsEnabled, timezone } = snapshot;
      if (!memberSmsEnabled) return;
      // Every text of this run reuses one provider resolution and this settings snapshot. Each text's last check
      // still reads the locked settings, so a switch turned off mid-run stops the remaining texts.
      const run = { resolver: onceResolver(options.sms.resolver, gymId), settings: { get: async () => snapshot } };
      const groups = await scope(gymId, tx => readNoticePhones(tx, gymId, notice.memberIds));
      const prefix = `${cancellationSmsKeyPrefix}${noticeScope(notice.sessionId, notice.round)}:`;
      // A notice from before a restore never sends after it, even when the session is cancelled again.
      const isCurrent = <S extends { status: string; restoreCount: number }>(session?: S): session is S =>
        session?.status === 'cancelled' && session.restoreCount === (notice.round ?? 0);
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
            if (!isCurrent(session)) return;
            const current = (await readNoticePhones(tx, gymId, group.memberIds)).find(row => row.phoneE164 === group.phoneE164);
            if (!current) return;
            if (current.memberIds[0] !== anchor) throw new AppError('conflict', 'Cancellation text recipients changed');
            const digest = prefix + options.sms!.phoneDigest(current.phoneE164);
            const previous = await tx.select().from(smsDeliveries).where(and(eq(smsDeliveries.gymId, gymId),
              or(eq(smsDeliveries.key, keyFor(anchor)), like(smsDeliveries.key, `${keyFor(anchor)}.%`), eq(smsDeliveries.commandDigest, digest),
                and(like(smsDeliveries.key, prefix + '%'), isNull(smsDeliveries.commandDigest), ne(smsDeliveries.state, 'not_accepted')))));
            const key = groupKey(previous, keyFor(anchor), anchor);
            // After erasure, match the covered IDs instead of restoring a digest. An older redacted row
            // without a group snapshot can only prove that a destination in the original roster was covered.
            const matching = previous.filter(row => {
              if (row.key === key || row.commandDigest === digest) return true;
              if (owned.has(memberKey(row.key))) return false;
              const snapshot = row.commandResult as { memberIds: string[] } | null;
              return snapshot ? snapshot.memberIds.some(id => current.memberIds.includes(id))
                : notice.memberIds.includes(memberKey(row.key).slice(prefix.length));
            });
            if (matching.some(row => row.state === 'sending' && row.updatedAt.getTime() > clock.now().getTime() - smsInFlightMs))
              throw new AppError('conflict', 'Cancellation text is in flight');
            if (matching.some(row => row.state !== 'not_accepted')) return;
            // A definite non-send can be retried, including after the first member in an address group changes. Prefer
            // this group's own key, and never take over a key that another job-start phone group owns.
            const retry = matching.find(row => row.key === key) ?? matching.find(row => !owned.has(memberKey(row.key)));
            const [updated] = retry ? await tx.update(smsDeliveries).set({ commandDigest: digest }).where(and(eq(smsDeliveries.id, retry.id),
              isNotNull(smsDeliveries.commandDigest))).returning({ key: smsDeliveries.key }) : [];
            const reserved = await deliveries.reserve(tx, gymId, updated?.key ?? key, digest);
            await deliveries.remember(tx, reserved, { memberIds: current.memberIds });
            return { reserved, session, memberIds: current.memberIds };
          });
          if (!reservation) continue;
          let covered: readonly string[] | undefined;
          const guarded: Sms = {
            verifyAccount: () => noticeSender(options, gymId, group, undefined, run).verifyAccount(),
            async sendSms() {
              const reread = await scope(gymId, async tx => {
                const [session] = await tx.select({ status: classSessions.status, restoreCount: classSessions.restoreCount })
                  .from(classSessions).where(eq(classSessions.id, notice.sessionId));
                return isCurrent(session) ? readNoticePhones(tx, gymId, reservation.memberIds) : [];
              });
              const current = reread.find(row => row.phoneE164 === group.phoneE164);
              // The retry regroups reserved members who moved to another consented phone since the reservation.
              if (!current && reread.length) throw new DeliveryError('not_accepted', 'Cancellation text recipients moved');
              if (!current) return { status: 'suppressed', reason: 'no_consent' };
              const bodyFor = (self: boolean, names: readonly string[] = current.memberNames) => t(self ? 'announcements/cancellation:sms_self' : 'announcements/cancellation:sms', {
                name: reservation.session.name, ...noticeWhen(reservation.session.startsAt, timezone), names: names.join(', '),
              });
              let moved = false;
              // Lock order matches promotion and staff cancellation texts: settings key share, session FOR SHARE,
              // then reserved members and their households FOR SHARE NOWAIT so a busy row rolls back and retries.
              const lastCheck: NonNullable<MemberSmsOptions['recheck']> = async tx => {
                moved = false; covered = undefined;
                await holdGymSettings(tx, gymId);
                const gym = await readGymSettings(tx, gymId);
                const [session] = await tx.select({ status: classSessions.status, restoreCount: classSessions.restoreCount })
                  .from(classSessions).where(and(eq(classSessions.gymId, gymId), eq(classSessions.id, notice.sessionId))).for('share');
                if (!isCurrent(session)) return 'no_consent';
                if (!(await shareNoticeRecipients(tx, gymId, reservation.memberIds))) return 'no_consent';
                const currentGroups = await memberNoticePhones(tx, gymId, reservation.memberIds);
                const now = currentGroups.find(row => row.phoneE164 === group.phoneE164);
                // Measured against the reserved members: one now at another phone, or back at this phone after the
                // reread left them out (so this text couldn't name them), ends the attempt so the retry regroups.
                if (currentGroups.some(row => row.phoneE164 !== group.phoneE164 && row.memberIds.some(id => reservation.memberIds.includes(id)))
                  || now?.memberIds.some(id => !current.memberIds.includes(id))) {
                  moved = true;
                  return 'phone_changed';
                }
                if (!now || !now.memberIds.length) return 'no_consent';
                covered = now.memberIds;
                return {
                  ...noticeCapSettings(gym),
                  memberIds: now.memberIds,
                  householdIds: now.consentHouseholdIds,
                  body: bodyFor(selfNotice(now), now.memberIds.map(id => current.memberNames[current.memberIds.indexOf(id)]!)),
                };
              };
              // Format all texts in the job's timezone. The last check locks the send settings and recipient.
              const result = await noticeSender(options, gymId, current, lastCheck, run).sendSms({ to: current.phoneE164, body: bodyFor(selfNotice(current)) });
              if (moved) throw new DeliveryError('not_accepted', 'Cancellation text recipients moved');
              return result;
            },
          };
          const result = await deliveries.attempt(reservation.reserved, guarded, { to: group.phoneE164, body: '' });
          if (result.status === 'sent') await recordCovered(scope, gymId, reservation.reserved.id, reservation.memberIds, covered);
        } catch (error) { failure ??= error; }
      }
      // A failed phone must not strand the rest of the roster. Unknown reservations never send again on retry.
      if (failure) throw failure;
    },
  };
}

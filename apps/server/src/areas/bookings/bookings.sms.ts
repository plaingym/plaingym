// SPDX-License-Identifier: AGPL-3.0-only
import { inArray } from 'drizzle-orm';
import { forGym, members, type Transaction } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createSmsDeliveries, MemberSms, type Sms } from '../../infra/sms/index.js';
import type { SmsResolver } from '../settings/sms.js';
import { memberNoticePhones } from '../members/sms-recipients.js';
import messages from '../../../../../locales/en/bookings/bookings.json' with { type: 'json' };

export interface ClassNoticeSmsOptions {
  resolver: SmsResolver;
  /** Runtime supplies createSmsPhoneDigest(AUTH_SECRET); a plain phone hash is unsafe. */
  phoneDigest(phone: string): string;
}
export interface ClassNoticeDeliveryOptions {
  scope: typeof forGym; clock: Clock; settings: GymSettingsAccessor; sms?: ClassNoticeSmsOptions;
}
/** Only members in the notice's snapshot can contribute a name or authorize a destination. */
export async function readNoticePhones(tx: Transaction, gymId: string, memberIds: readonly string[]) {
  const groups = await memberNoticePhones(tx, gymId, memberIds);
  if (!groups.length) return [];
  const people = await tx.select({ id: members.id, firstName: members.firstName, lastName: members.lastName }).from(members)
    .where(inArray(members.id, groups.flatMap(group => group.memberIds)));
  const names = new Map(people.map(person => [person.id, `${person.firstName} ${person.lastName}`]));
  return groups.map(group => ({ ...group, memberNames: group.memberIds.map(id => names.get(id)!) }));
}
export function noticeWhen(startsAt: Date, timezone: string) {
  return { date: localDate(startsAt, timezone), time: new Intl.DateTimeFormat('en', {
    timeZone: timezone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(startsAt) };
}
export function noticeSender(options: ClassNoticeDeliveryOptions, gymId: string, group: Awaited<ReturnType<typeof readNoticePhones>>[number]) {
  return new MemberSms({ gymId, kind: 'notices', memberIds: group.memberIds, householdIds: group.consentHouseholdIds,
    resolver: options.sms!.resolver, settings: options.settings, scope: options.scope, clock: options.clock });
}

interface PromotionNotice { memberId: string; session: { name: string; startsAt: Date } }
/** The load callback rechecks promotion age, booking/session state and gym ownership independently of email audits. */
export function createBookingSms(options: ClassNoticeDeliveryOptions & {
  load(gymId: string, bookingId: string): Promise<PromotionNotice | undefined>;
}) {
  const deliveries = createSmsDeliveries(options), t = createTranslator({ 'bookings/bookings': messages });
  return async (gymId: string, bookingId: string) => {
    if (!options.sms || !(await options.settings.get(gymId)).memberSmsEnabled) return;
    const row = await options.load(gymId, bookingId);
    if (!row) return;
    const [group] = await options.scope(gymId, tx => readNoticePhones(tx, gymId, [row.memberId]));
    if (!group) return;
    // Reserve the booking key before resolving credentials or calling the provider.
    const reserved = await options.scope(gymId, tx => deliveries.reserve(tx, gymId, `booking-promotion-sms:${bookingId}`));
    if (!reserved) return;
    const guarded: Sms = {
      verifyAccount: () => noticeSender(options, gymId, group).verifyAccount(),
      async sendSms() {
        const latest = await options.load(gymId, bookingId);
        if (!latest) return { status: 'suppressed', reason: 'no_consent' };
        const [current] = await options.scope(gymId, tx => readNoticePhones(tx, gymId, [latest.memberId]));
        if (!current || current.phoneE164 !== group.phoneE164) return { status: 'suppressed', reason: 'phone_changed' };
        const gym = await options.settings.get(gymId);
        return noticeSender(options, gymId, current).sendSms({ to: current.phoneE164,
          body: t('bookings/bookings:promotionSms', { name: latest.session.name, ...noticeWhen(latest.session.startsAt, gym.timezone),
            names: current.memberNames.join(', ') }) });
      },
    };
    await deliveries.attempt(reserved, guarded, { to: group.phoneE164, body: '' });
  };
}

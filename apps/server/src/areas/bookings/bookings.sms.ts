// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { classBookings, classSessions, databaseCode, forGym, households, members, type Transaction } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { localDate } from '@plaingym/shared/time';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { createSmsDeliveries, MemberSms, SmsRecheckBusy, type MemberSmsOptions, type Sms, type SmsRecheckSettings, type SmsSuppression } from '../../infra/sms/index.js';
import type { SmsResolver } from '../settings/sms.js';
import { holdGymSettings, readGymSettings } from '../settings/settings.js';
import { memberNoticePhones } from '../members/sms-recipients.js';
import messages from '../../../../../locales/en/bookings/bookings.json' with { type: 'json' };

type GymSettings = Awaited<ReturnType<typeof readGymSettings>>;
type SmsSuppressionReason = SmsSuppression['reason'];

export interface ClassNoticeSmsOptions {
  resolver: SmsResolver;
  /** Runtime supplies createSmsPhoneDigest(AUTH_SECRET); a plain phone hash is unsafe. */
  phoneDigest(phone: string): string;
}
export interface ClassNoticeDeliveryOptions {
  scope: typeof forGym; clock: Clock; settings: GymSettingsAccessor; sms?: ClassNoticeSmsOptions;
}
/** Maps a `readGymSettings` result into the settings snapshot `MemberSms`'s cap transaction uses. */
export function noticeCapSettings(gym: GymSettings): SmsRecheckSettings {
  return { memberSmsEnabled: gym.memberSmsEnabled, smsDailyCap: gym.smsDailyCap, timezone: gym.timezone, country: gym.address.country ?? null };
}
async function share<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (error) { throw databaseCode(error) === '55P03' ? new SmsRecheckBusy() : error; }
}
/**
 * Locks each member and then each distinct household `FOR SHARE NOWAIT`, in sorted ID order. Member erasure and
 * deletion lock the household and member before the session, so a busy row throws `SmsRecheckBusy` to roll back the
 * cap transaction and let `MemberSms` retry. Returns `false` when any member row is missing.
 */
export async function shareNoticeRecipients(tx: Transaction, gymId: string, memberIds: readonly string[]): Promise<boolean> {
  const householdIds = new Set<string>();
  for (const memberId of [...new Set(memberIds)].sort()) {
    const [person] = await share(() => tx.select({ householdId: members.householdId }).from(members)
      .where(and(eq(members.gymId, gymId), eq(members.id, memberId))).for('share', { noWait: true }));
    if (!person) return false;
    householdIds.add(person.householdId);
  }
  for (const householdId of [...householdIds].sort()) {
    await share(() => tx.select({ id: households.id }).from(households)
      .where(and(eq(households.gymId, gymId), eq(households.id, householdId))).for('share', { noWait: true }));
  }
  return true;
}
/**
 * Shared lock sequence for a booking text's last check in the cap transaction: settings key share and read, booking's
 * session `FOR SHARE`, caller `reload`, then member and household `FOR SHARE NOWAIT`.
 */
export async function lockBookingNotice<T extends { memberId: string }>(
  tx: Transaction, gymId: string, bookingId: string,
  reload: (tx: Transaction) => Promise<T | SmsSuppressionReason>,
): Promise<'no_booking' | SmsSuppressionReason | { gym: GymSettings; loaded: T }> {
  await holdGymSettings(tx, gymId);
  const gym = await readGymSettings(tx, gymId);
  const [booking] = await tx.select({ sessionId: classBookings.sessionId }).from(classBookings)
    .where(and(eq(classBookings.gymId, gymId), eq(classBookings.id, bookingId)));
  if (!booking) return 'no_booking';
  await tx.select({ id: classSessions.id }).from(classSessions)
    .where(and(eq(classSessions.gymId, gymId), eq(classSessions.id, booking.sessionId))).for('share');
  const loaded = await reload(tx);
  if (typeof loaded === 'string') return loaded;
  if (!(await shareNoticeRecipients(tx, gymId, [loaded.memberId]))) return 'no_consent';
  return { gym, loaded };
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
export function noticeSender(options: ClassNoticeDeliveryOptions, gymId: string, group: Awaited<ReturnType<typeof readNoticePhones>>[number],
  recheck?: MemberSmsOptions['recheck']) {
  return new MemberSms({ gymId, kind: 'notices', memberIds: group.memberIds, householdIds: group.consentHouseholdIds,
    resolver: options.sms!.resolver, settings: options.settings, scope: options.scope, clock: options.clock, ...(recheck ? { recheck } : {}) });
}

interface PromotionNotice { memberId: string; session: { name: string; startsAt: Date } }
/** The load callback rechecks promotion age, booking/session state and gym ownership independently of email audits. */
export function createBookingSms(options: ClassNoticeDeliveryOptions & {
  load(tx: Transaction, gymId: string, bookingId: string): Promise<PromotionNotice | undefined>;
}) {
  const deliveries = createSmsDeliveries(options), t = createTranslator({ 'bookings/bookings': messages });
  return async (gymId: string, bookingId: string) => {
    if (!options.sms || !(await options.settings.get(gymId)).memberSmsEnabled) return;
    const row = await options.scope(gymId, tx => options.load(tx, gymId, bookingId));
    if (!row) return;
    const [group] = await options.scope(gymId, tx => readNoticePhones(tx, gymId, [row.memberId]));
    if (!group) return;
    // Reserve the booking key before resolving credentials or calling the provider.
    const reserved = await options.scope(gymId, tx => deliveries.reserve(tx, gymId, `booking-promotion-sms:${bookingId}`));
    if (!reserved) return;
    // The current promotion and its preferred consented phone, which must still be the reserved destination.
    const recipientCheck = async (tx: Transaction, loaded?: PromotionNotice) => {
      const latest = loaded ?? await options.load(tx, gymId, bookingId);
      if (!latest) return { reason: 'no_consent' } as const;
      const [current] = await readNoticePhones(tx, gymId, [latest.memberId]);
      if (!current) return { reason: 'no_consent' } as const;
      if (current.phoneE164 !== group.phoneE164) return { reason: 'phone_changed' } as const;
      return { latest, current };
    };
    const promotionBody = (latest: PromotionNotice, current: typeof group, timezone: string) =>
      t('bookings/bookings:promotionSms', { name: latest.session.name, ...noticeWhen(latest.session.startsAt, timezone),
        names: current.memberNames.join(', ') });
    // Staff cancellation takes the session lock before changing the booking. Holding it through the cap reservation
    // keeps cancellation from overtaking the eligibility check. The member and household locks protect the recipient choice.
    // Member erasure and deletion lock the household and member before the session, so those two locks never wait: when
    // either is busy the whole check rolls back, releasing the session, and MemberSms retries it from the booking reread.
    const lastCheck: NonNullable<MemberSmsOptions['recheck']> = async (tx: Transaction) => {
      const locked = await lockBookingNotice(tx, gymId, bookingId, async tx => (await options.load(tx, gymId, bookingId)) ?? 'no_consent');
      if (typeof locked === 'string') return locked === 'no_booking' ? 'no_consent' : locked;
      const checked = await recipientCheck(tx, locked.loaded);
      if ('reason' in checked) return checked.reason;
      return {
        ...noticeCapSettings(locked.gym),
        memberIds: checked.current.memberIds,
        householdIds: checked.current.consentHouseholdIds,
        body: promotionBody(checked.latest, checked.current, locked.gym.timezone),
      };
    };
    const guarded: Sms = {
      verifyAccount: () => noticeSender(options, gymId, group).verifyAccount(),
      async sendSms() {
        const checked = await options.scope(gymId, tx => recipientCheck(tx));
        if ('reason' in checked) return { status: 'suppressed', reason: checked.reason };
        const { latest, current } = checked;
        const gym = await options.settings.get(gymId);
        return noticeSender(options, gymId, current, lastCheck).sendSms({
          to: current.phoneE164,
          body: promotionBody(latest, current, gym.timezone),
        });
      },
    };
    await deliveries.attempt(reserved, guarded, { to: group.phoneE164, body: '' });
  };
}

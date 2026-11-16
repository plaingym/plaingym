// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, members, households, writeAudit } from '@plaingym/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Clock } from '@plaingym/shared';
import { normalizePhone } from '@plaingym/shared/phone';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as systemClock } from '../../core/clock.js';
import { logInfo } from '../../core/log.js';
import type { SmsResolver } from '../../areas/settings/sms.js';
import { takeSmsSlot } from './daily-cap.js';
import { DeliveryError, SmsDeliveryError, validateSms, type Sms, type SmsMessage, type SmsResult } from './index.js';

type SuppressionReason = Extract<SmsResult, { status: 'suppressed' }>['reason'];
export interface SmsSuppression {
  readonly event: 'sms.suppressed'; readonly gymId: string; readonly memberIds: readonly string[]; readonly reason: SuppressionReason;
}
export interface MemberSmsOptions {
  readonly gymId: string; readonly memberIds: readonly string[]; readonly householdIds: readonly string[];
  readonly kind: 'notices' | 'announcements'; readonly resolver: SmsResolver; readonly settings: GymSettingsAccessor;
  readonly scope?: typeof forGym; readonly clock?: Clock; readonly logSuppression?: (event: SmsSuppression) => void;
}
/** One wrapper per recipient group, always used inside an at-most-once delivery attempt. */
export class MemberSms implements Sms {
  readonly #options: MemberSmsOptions;
  constructor(options: MemberSmsOptions) { this.#options = { ...options, memberIds: [...new Set(options.memberIds)], householdIds: [...new Set(options.householdIds)] }; }
  async verifyAccount(): Promise<void> {
    assertNoTransaction('sms.verifyAccount');
    const resolved = await this.#options.resolver.resolve(this.#options.gymId);
    if (!resolved || resolved.gymId !== this.#options.gymId) throw new DeliveryError('not_accepted', 'SMS provider unavailable');
    await resolved.sms.verifyAccount();
  }
  async sendSms(message: SmsMessage): Promise<SmsResult> {
    assertNoTransaction('sms.sendSms');
    const { gymId, memberIds, householdIds, kind, settings, resolver } = this.#options;
    const scope = this.#options.scope ?? forGym, clock = this.#options.clock ?? systemClock;
    let resolved: Awaited<ReturnType<SmsResolver['resolve']>>, outgoing: SmsMessage;
    try {
      // Resolve before the final settings and consent reads so slow credential reads cannot stale those checks.
      resolved = await resolver.resolve(gymId);
      const gym = await settings.get(gymId);
      if (gym.gymId !== gymId || (resolved && resolved.gymId !== gymId)) throw new Error('SMS gym mismatch');
      if (!gym.memberSmsEnabled) return this.#suppressed('disabled');
      if (!resolved) return this.#suppressed('no_provider');
      // Checked with the gym name added, before a cap slot is taken for a message the transport would refuse.
      outgoing = { ...message, body: `${resolved.name}: ${message.body}` };
      validateSms(outgoing);
      const reason = await scope(gymId, async tx => {
        if ((!memberIds.length && !householdIds.length) || (kind === 'announcements' && householdIds.length)) return 'no_consent';
        const homes = householdIds.length ? await tx.select({ phone: households.phone, phoneE164: households.phoneE164,
          smsNoticesConsentAt: households.smsNoticesConsentAt }).from(households).where(inArray(households.id, [...householdIds])) : [];
        const people = memberIds.length ? await tx.select({ householdId: members.householdId, anonymizedAt: members.anonymizedAt, phone: members.phone,
          phoneE164: members.phoneE164, smsNoticesConsentAt: members.smsNoticesConsentAt,
          smsAnnouncementsConsentAt: members.smsAnnouncementsConsentAt }).from(members).where(inArray(members.id, [...memberIds])) : [];
        if (homes.length !== householdIds.length || people.length !== memberIds.length) return 'no_consent';
        for (const home of homes) {
          if (!home.smsNoticesConsentAt) return 'no_consent';
          if (home.phoneE164 !== message.to || normalizePhone(home.phone, gym.country) !== message.to) return 'phone_changed';
        }
        for (const member of people) {
          if (member.anonymizedAt) return 'no_consent';
          // A child reached on the billing phone is authorized by that household's checked notices consent.
          if (householdIds.includes(member.householdId)) continue;
          if (!(kind === 'notices' ? member.smsNoticesConsentAt : member.smsAnnouncementsConsentAt)) return 'no_consent';
          if (member.phoneE164 !== message.to || normalizePhone(member.phone, gym.country) !== message.to) return 'phone_changed';
        }
        return await takeSmsSlot(tx, gymId, clock.now(), gym.timezone, gym.smsDailyCap) ? undefined : 'cap_reached';
      });
      if (reason) return this.#suppressed(reason);
    } catch (error) {
      // validateSms's refusal carries a fixed message; any other failure is replaced.
      throw error instanceof DeliveryError ? error : new DeliveryError('not_accepted', 'SMS recipient checks failed');
    }
    // Every read and the cap reservation have committed before this network boundary.
    try { return await resolved.sms.sendSms(outgoing); }
    catch (error) {
      if (error instanceof SmsDeliveryError && error.reason === 'recipient_opted_out') {
        try {
          await scope(gymId, async tx => {
            const now = clock.now();
            const people = await tx.select({ id: members.id, revision: members.revision }).from(members)
              .where(and(eq(members.gymId, gymId), eq(members.phoneE164, message.to))).orderBy(members.id).for('update');
            const homes = await tx.select({ id: households.id, revision: households.revision }).from(households)
              .where(and(eq(households.gymId, gymId), eq(households.phoneE164, message.to))).orderBy(households.id).for('update');
            for (const member of people) {
              await tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null,
                smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null, revision: member.revision + 1 }).where(eq(members.id, member.id));
              await writeAudit(tx, { gymId, actorKind: 'system', action: 'member.sms_opted_out', targetType: 'member', targetId: member.id, after: { source: 'provider' }, occurredAt: now });
            }
            for (const home of homes) {
              await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null, revision: home.revision + 1 }).where(eq(households.id, home.id));
              await writeAudit(tx, { gymId, actorKind: 'system', action: 'household.sms_opted_out', targetType: 'household', targetId: home.id, after: { source: 'provider' }, occurredAt: now });
            }
          });
        } catch { throw new DeliveryError('not_accepted', 'SMS opt-out could not be recorded'); }
      }
      throw error;
    }
  }
  #suppressed(reason: SuppressionReason): SmsResult {
    const event: SmsSuppression = { event: 'sms.suppressed', gymId: this.#options.gymId, memberIds: this.#options.memberIds, reason };
    (this.#options.logSuppression ?? (({ event: name, memberIds, ...fields }) => logInfo(name, { ...fields, memberIds: memberIds.join(',') })))(event);
    return { status: 'suppressed', reason };
  }
}

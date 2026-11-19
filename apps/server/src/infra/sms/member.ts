// SPDX-License-Identifier: AGPL-3.0-only
import { forGym, members, households, smsDailyUsage, writeAudit, type Transaction } from '@plaingym/db';
import { and, eq, gt, inArray } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- SQL only sets local timeouts and atomically decrements gym-scoped SMS usage.
import { sql } from 'drizzle-orm';
import type { Clock } from '@plaingym/shared';
import { normalizePhone } from '@plaingym/shared/phone';
import { localDate } from '@plaingym/shared/time';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { GymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { clock as systemClock } from '../../core/clock.js';
import { logError, logInfo } from '../../core/log.js';
import type { SmsResolver } from '../../areas/settings/sms.js';
import { takeSmsSlot } from './daily-cap.js';
import { smsDeadlineMs } from './constants.js';
import { DeliveryError, SmsDeliveryError, validateSms, type Sms, type SmsMessage, type SmsResult } from './index.js';

type SuppressionReason = Extract<SmsResult, { status: 'suppressed' }>['reason'];
function setPreparationTimeouts(tx: Transaction, milliseconds: number) {
  const timeout = milliseconds + 'ms';
  // eslint-disable-next-line database/system-tables -- Set connection limits only for this transaction; no table access.
  return tx.execute(sql`select set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`);
}

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
    // Keep preparation below half a transport deadline: together with the provider's deadline this stays
    // inside the two-deadline delivery window. Use a monotonic deadline for the wait, independent of the gym clock.
    const deadline = performance.now() + smsDeadlineMs / 2;
    let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = () => new DeliveryError('not_accepted', 'SMS recipient checks timed out');
    const remaining = () => Math.ceil(deadline - performance.now());
    const requireTime = () => {
      const milliseconds = remaining();
      if (expired || milliseconds <= 0) throw timedOut();
      return milliseconds;
    };
    const prepare = async () => {
      // Resolve before the final settings and consent reads so slow credential reads cannot stale those checks.
      const resolved = await resolver.resolve(gymId);
      const gym = await settings.get(gymId);
      requireTime();
      if (gym.gymId !== gymId || (resolved && resolved.gymId !== gymId)) throw new Error('SMS gym mismatch');
      if (!gym.memberSmsEnabled) return this.#suppressed('disabled');
      if (!resolved) return this.#suppressed('no_provider');
      // Checked with the gym name added, before a cap slot is taken for a message the transport would refuse.
      const outgoing = { ...message, body: `${resolved.name}: ${message.body}` };
      validateSms(outgoing);
      const checked = await scope(gymId, async tx => {
        await setPreparationTimeouts(tx, requireTime());
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
        await setPreparationTimeouts(tx, requireTime());
        requireTime();
        const now = clock.now();
        const allowed = await takeSmsSlot(tx, gymId, now, gym.timezone, gym.smsDailyCap);
        requireTime();
        return allowed ? { slotDay: localDate(now, gym.timezone) } : 'cap_reached';
      });
      if (expired || remaining() <= 0) {
        // COMMIT may win at the database after the deadline wins at the caller. Return only a confirmed slot.
        if (typeof checked === 'object') {
          try {
            await scope(gymId, async tx => {
              await setPreparationTimeouts(tx, 3_000);
              await tx.update(smsDailyUsage).set({ sent: sql`${smsDailyUsage.sent} - 1` })
                .where(and(eq(smsDailyUsage.gymId, gymId), eq(smsDailyUsage.day, checked.slotDay), gt(smsDailyUsage.sent, 0)));
            });
          } catch (error) {
            // Retrying an uncertain release could subtract a slot used by a different send.
            logError('sms.slot_release_failed', { gymId, day: checked.slotDay }, error);
          }
        }
        throw timedOut();
      }
      if (typeof checked === 'string') return this.#suppressed(checked);
      return { resolved, outgoing };
    };
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { expired = true; reject(timedOut()); }, remaining());
      });
      prepared = await Promise.race([prepare(), timeout]);
    } catch (error) {
      // validateSms's refusal carries a fixed message; any other failure is replaced.
      throw error instanceof DeliveryError ? error : new DeliveryError('not_accepted', 'SMS recipient checks failed');
    } finally { clearTimeout(timer); }
    if ('status' in prepared) return prepared;
    // Every read and the cap reservation have committed before this network boundary.
    try { return await prepared.resolved.sms.sendSms(prepared.outgoing); }
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

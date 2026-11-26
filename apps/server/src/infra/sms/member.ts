// SPDX-License-Identifier: AGPL-3.0-only
import { databaseCode, forGym, members, households, smsDailyUsage, smsOptedOutNumbers, writeAudit, type Transaction } from '@plaingym/db';
import { and, eq, gt, inArray, isNull, notExists, or } from 'drizzle-orm';
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
const preparationTimeoutMarginMs = 250;
const correctionTimeoutMs = 3_000;

function setPreparationTimeouts(tx: Transaction, milliseconds: number) {
  const timeout = milliseconds + 'ms';
  // eslint-disable-next-line database/system-tables -- Set connection limits only for this transaction; no table access.
  return tx.execute(sql`select set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`);
}

function isDatabaseTimeout(error: unknown): boolean {
  const code = databaseCode(error);
  return code === '55P03' || code === '57014';
}

async function correctLateUsage(scope: typeof forGym, gymId: string, day: string,
  counter: 'sent' | 'refused', remaining: () => number): Promise<void> {
  const column = smsDailyUsage[counter];
  let previousTimeout: unknown;
  for (;;) {
    try {
      await scope(gymId, async tx => {
        const milliseconds = Math.floor(remaining());
        // The first correction keeps its full timeouts, even when preparation commits near or after the end of
        // the wait. A retry can spend its remaining time waiting for a connection, and fits the time left.
        if (previousTimeout !== undefined && milliseconds <= 0) throw previousTimeout;
        await setPreparationTimeouts(tx, previousTimeout === undefined ? correctionTimeoutMs : Math.min(correctionTimeoutMs, milliseconds));
        await tx.update(smsDailyUsage).set({ [counter]: sql`${column} - 1` })
          .where(and(eq(smsDailyUsage.gymId, gymId), eq(smsDailyUsage.day, day), gt(column, 0)));
      });
      return;
    } catch (error) {
      // These PostgreSQL timeouts abort the transaction. Retrying an uncertain commit could subtract
      // another attempt's increment.
      if (!isDatabaseTimeout(error) || remaining() < 1) {
        logError('sms.usage_correction_failed', { gymId, day, counter }, error);
        return;
      }
      previousTimeout = error;
    }
  }
}

export interface SmsSuppression {
  readonly event: 'sms.suppressed'; readonly gymId: string; readonly memberIds: readonly string[]; readonly reason: SuppressionReason;
}
/**
 * The gym settings a sender's last check read in the cap transaction: the switch, the daily cap, the timezone that picks
 * the usage day and the country that normalizes stored phones. Optional `memberIds`, `householdIds` and `body` are the
 * consent holders and message body chosen under the recheck's locks; when set they replace the sender's own for this check.
 */
export interface SmsRecheckSettings {
  readonly memberSmsEnabled: boolean; readonly smsDailyCap: number; readonly timezone: string; readonly country: string | null;
  readonly memberIds?: readonly string[]; readonly householdIds?: readonly string[]; readonly body?: string;
}
/**
 * Thrown by a sender's `recheck` when a row it must lock is busy (for example a `NOWAIT` lock refused while staff
 * change the member). The cap transaction rolls back with no slot, and `MemberSms` reruns it after a short pause while
 * the preparation deadline allows. A check still busy when that time is used up ends as a `no_consent` suppression.
 */
export class SmsRecheckBusy extends Error {
  constructor() { super('SMS recipient rows are busy'); this.name = 'SmsRecheckBusy'; }
}
const recheckPauseMs = 50;
/**
 * A resolver for one job that sends several texts for one gym: the first `resolve` call's result, a provider or a
 * rejection, is reused by every later call, so the credentials are read and decrypted once per job. Each text still
 * runs its own switch, consent and cap checks. Resolving another gym throws; `status` and `configured` pass through.
 */
export function onceResolver(resolver: SmsResolver, gymId: string): SmsResolver {
  let resolved: Promise<Awaited<ReturnType<SmsResolver['resolve']>>> | undefined;
  return {
    async resolve(id) {
      if (id !== gymId) throw new Error('SMS gym mismatch');
      // A cached result still refuses a caller inside a transaction, as the plain resolver does.
      assertNoTransaction('sms.resolve');
      return resolved ??= resolver.resolve(gymId);
    },
    status: id => resolver.status(id),
    configured: id => resolver.configured(id),
  };
}
export interface MemberSmsOptions {
  readonly gymId: string; readonly memberIds: readonly string[]; readonly householdIds: readonly string[];
  readonly kind: 'notices' | 'announcements'; readonly resolver: SmsResolver; readonly settings: GymSettingsAccessor;
  readonly scope?: typeof forGym; readonly clock?: Clock; readonly logSuppression?: (event: SmsSuppression) => void;
  /**
   * The sender's own last check, run first in the cap transaction (after credentials resolve, before the consent reads
   * and the slot, inside the preparation deadline). It locks and reads the rows its recipient decision uses in `tx`,
   * with no nested transaction or network call, and returns a suppression reason or the gym settings read in `tx`.
   * Those replace the earlier settings snapshot for every later step: the switch, phone normalization, the usage day and
   * the cap, including a late usage correction. Optional consent holders and body in that result replace the sender's
   * own for this check. Throwing `SmsRecheckBusy` gives way: the transaction rolls back and the whole check, recheck
   * first, runs again in a fresh transaction.
   */
  readonly recheck?: (tx: Transaction) => Promise<SuppressionReason | SmsRecheckSettings>;
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
    let expired = false, usageMayCommit = false, timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = () => new DeliveryError('not_accepted', 'SMS recipient checks timed out');
    const remaining = () => Math.ceil(deadline - performance.now());
    const correctionRemaining = () => deadline + smsDeadlineMs - performance.now();
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
      const check = () => scope(gymId, async tx => {
        await setPreparationTimeouts(tx, Math.max(1, requireTime() - preparationTimeoutMarginMs));
        let current: Pick<SmsRecheckSettings, 'smsDailyCap' | 'timezone' | 'country'> = gym;
        let checkMemberIds = memberIds, checkHouseholdIds = householdIds, finalOutgoing = outgoing;
        if (this.#options.recheck) {
          const locked = await this.#options.recheck(tx);
          requireTime();
          if (typeof locked === 'string') return locked;
          if (!locked.memberSmsEnabled) return 'disabled';
          current = locked;
          if (locked.memberIds !== undefined) checkMemberIds = [...new Set(locked.memberIds)];
          if (locked.householdIds !== undefined) checkHouseholdIds = [...new Set(locked.householdIds)];
          if (locked.body !== undefined) {
            finalOutgoing = { ...message, body: `${resolved.name}: ${locked.body}` };
            validateSms(finalOutgoing);
          }
        }
        const { smsDailyCap: cap, timezone, country } = current;
        if ((!checkMemberIds.length && !checkHouseholdIds.length) || (kind === 'announcements' && checkHouseholdIds.length)) return 'no_consent';
        const homes = checkHouseholdIds.length ? await tx.select({ phone: households.phone, phoneE164: households.phoneE164,
          smsNoticesConsentAt: households.smsNoticesConsentAt }).from(households).where(inArray(households.id, [...checkHouseholdIds])) : [];
        const people = checkMemberIds.length ? await tx.select({ householdId: members.householdId, anonymizedAt: members.anonymizedAt, phone: members.phone,
          phoneE164: members.phoneE164, smsNoticesConsentAt: members.smsNoticesConsentAt,
          smsAnnouncementsConsentAt: members.smsAnnouncementsConsentAt }).from(members).where(inArray(members.id, [...checkMemberIds])) : [];
        if (homes.length !== checkHouseholdIds.length || people.length !== checkMemberIds.length) return 'no_consent';
        for (const home of homes) {
          if (!home.smsNoticesConsentAt) return 'no_consent';
          if (home.phoneE164 !== message.to || normalizePhone(home.phone, country) !== message.to) return 'phone_changed';
        }
        for (const member of people) {
          if (member.anonymizedAt) return 'no_consent';
          // A child reached on the billing phone is authorized by that household's checked notices consent.
          if (checkHouseholdIds.includes(member.householdId)) continue;
          if (!(kind === 'notices' ? member.smsNoticesConsentAt : member.smsAnnouncementsConsentAt)) return 'no_consent';
          if (member.phoneE164 !== message.to || normalizePhone(member.phone, country) !== message.to) return 'phone_changed';
        }
        await setPreparationTimeouts(tx, Math.max(1, requireTime() - preparationTimeoutMarginMs));
        requireTime();
        const now = clock.now();
        const allowed = await takeSmsSlot(tx, gymId, now, timezone, cap);
        const day = localDate(now, timezone);
        requireTime();
        usageMayCommit = true;
        return { day, counter: allowed ? 'sent' : 'refused', outgoing: finalOutgoing } as const;
      });
      let checked: Awaited<ReturnType<typeof check>>;
      for (;;) {
        try { checked = await check(); break; }
        catch (error) {
          // A busy recheck rolled back before the slot, so this try left no usage. Retry while a pause and a new try fit.
          if (!(error instanceof SmsRecheckBusy)) throw error;
          if (expired || remaining() <= recheckPauseMs + preparationTimeoutMarginMs) { checked = 'no_consent'; break; }
          await new Promise(resolve => setTimeout(resolve, recheckPauseMs));
        }
      }
      if (expired || remaining() <= 0) {
        // Reverse only an increment confirmed by a committed transaction.
        if (typeof checked === 'object') await correctLateUsage(scope, gymId, checked.day, checked.counter, correctionRemaining);
        throw timedOut();
      }
      if (typeof checked === 'string') return this.#suppressed(checked);
      if (checked.counter === 'refused') return this.#suppressed('cap_reached');
      return { resolved, outgoing: checked.outgoing };
    };
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { expired = true; reject(timedOut()); }, remaining());
    });
    const preparation = prepare();
    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await Promise.race([preparation, timeout]);
    } catch (error) {
      // Once the usage write can commit, finish its cleanup before the caller retries or sends another group. Wait at
      // most the provider deadline this attempt no longer uses, so a stalled commit stays inside the in-flight window.
      if (expired && usageMayCommit) {
        let settle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([preparation.catch(() => undefined),
          new Promise<void>(resolve => { settle = setTimeout(resolve, Math.ceil(correctionRemaining())); })]);
        clearTimeout(settle);
      }
      // validateSms's refusal carries a fixed message; any other failure is replaced.
      if (error instanceof DeliveryError) throw error;
      if (isDatabaseTimeout(error)) throw timedOut();
      throw new DeliveryError('not_accepted', 'SMS recipient checks failed');
    } finally { clearTimeout(timer); }
    if ('status' in prepared) return prepared;
    // Every read and the cap reservation have committed before this network boundary.
    try { return await prepared.resolved.sms.sendSms(prepared.outgoing); }
    catch (error) {
      if (error instanceof SmsDeliveryError && error.reason === 'recipient_opted_out') {
        try {
          await scope(gymId, async tx => {
            // Lock households first (matching erasure's household-then-member lock order), then members, then read time.
            // The household lock leaves foreign-key checks free, so a writer holding a member while it adds a row that
            // references the household never waits on it.
            const lockedHomes = await tx.select({ id: households.id, revision: households.revision, phoneE164: households.phoneE164 }).from(households)
              .where(and(eq(households.gymId, gymId), or(eq(households.phoneE164, message.to),
                inArray(households.id, tx.select({ householdId: members.householdId }).from(members)
                  .where(and(eq(members.gymId, gymId), eq(members.phoneE164, message.to)))))))
              .orderBy(households.id).for('no key update');
            const people = await tx.select({ id: members.id, revision: members.revision }).from(members)
              .where(and(eq(members.gymId, gymId), eq(members.phoneE164, message.to))).orderBy(members.id).for('update');
            const homes = lockedHomes.filter(home => home.phoneE164 === message.to);
            // Read the time after every lock, so every consent write this opt-out waited on is ordered before it.
            const now = clock.now();
            if (/^\+[1-9][0-9]{1,14}$/.test(message.to)) {
              if (people.length || homes.length) {
                await tx.insert(smsOptedOutNumbers).values({ gymId, phoneE164: message.to, optedOutAt: now, createdAt: now })
                  .onConflictDoUpdate({ target: [smsOptedOutNumbers.gymId, smsOptedOutNumbers.phoneE164], set: { optedOutAt: now } });
              } else {
                await tx.delete(smsOptedOutNumbers).where(and(eq(smsOptedOutNumbers.gymId, gymId), eq(smsOptedOutNumbers.phoneE164, message.to),
                  notExists(tx.select({ id: members.id }).from(members).where(and(eq(members.gymId, gymId), eq(members.phoneE164, message.to), isNull(members.anonymizedAt)))),
                  notExists(tx.select({ id: households.id }).from(households).where(and(eq(households.gymId, gymId), eq(households.phoneE164, message.to))))));
              }
            }
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

// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { forGym, householdUsers, members, memberships, plans, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { currencySchema, dateSchema, idSchema } from '@plaingym/shared/contracts';
import { z } from 'zod';
import { clock as systemClock } from '../../core/clock.js';
import { logInfo } from '../../core/log.js';
import { commandDigest } from '../../infra/email/deliveries.js';
import { createEmailDeliveries, deliveryAcceptance, type Email } from '../../infra/email/index.js';
import { renderPriceChangeNotice } from '../../emails/billing/price-change.js';
import { householdRecipient } from '../members/household-recipient.js';
import { createGymSettingsAccessor, createSettingsService } from '../settings/settings.js';

export const priceNoticeJob = 'billing.memberships.price_notice';
// Additional stored keys are tolerated when a release rolls back.
export const priceNoticePayload = z.object({
  requestKey: idSchema, planId: idSchema, householdId: idSchema, membershipIds: z.array(idSchema).min(1),
  amountCents: z.int32().nonnegative(), currency: currencySchema, effectiveOn: dateSchema,
});
type Notice = z.infer<typeof priceNoticePayload>;
export interface PriceNoticeOptions {
  scope?: typeof forGym; clock?: Clock;
  /** Resolve the gym's SMTP transport; the demo outbox is selected separately. */
  mailer(gymId: string): Promise<Email | null>;
  demoMode?: boolean;
  demoEmailFor?(gymId: string): Email;
}

export function createPriceNotice(options: PriceNoticeOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? systemClock;
  const settings = createGymSettingsAccessor({ scope }), details = createSettingsService({ scope });
  const deliveries = createEmailDeliveries({ scope, clock });
  const demo = options.demoMode ?? process.env.DEMO_MODE === 'true';
  const log = (gymId: string, notice: Notice, reason: string) =>
    logInfo('billing.memberships.price_notice', { gymId, planId: notice.planId, householdId: notice.householdId, reason });

  async function read(tx: Transaction, gymId: string, notice: Notice) {
    const [plan] = await tx.select({ name: plans.name }).from(plans)
      .where(and(eq(plans.id, notice.planId), eq(plans.currency, notice.currency)));
    if (!plan) return { ok: false, reason: 'plan_missing' } as const;
    const recipient = await householdRecipient(tx, gymId, notice.householdId);
    if (!recipient || !z.email().safeParse(recipient.email).success) return { ok: false, reason: 'no_address' } as const;
    // The household billing address is the payer, including payers without a portal account.
    // Check both address matches and explicitly linked payers, so clearing an erased payer's email cannot bypass this.
    const family = await tx.select({ id: members.id, email: members.email, anonymizedAt: members.anonymizedAt })
      .from(members).where(eq(members.householdId, notice.householdId));
    const payers = await tx.select({ memberId: householdUsers.memberId }).from(householdUsers)
      .where(and(eq(householdUsers.householdId, notice.householdId), eq(householdUsers.scope, 'payer')));
    if (family.some(member => member.anonymizedAt && (member.email?.trim().toLowerCase() === recipient.email.toLowerCase()
      || payers.some(payer => payer.memberId === member.id)))) return { ok: false, reason: 'payer_erased' } as const;
    if (recipient.suppressed) return { ok: false, reason: 'recipient_suppressed' } as const;
    const current = await tx.select({ id: memberships.id, firstName: members.firstName, lastName: members.lastName,
      amountCents: memberships.amountCents, interval: memberships.interval, newInterval: memberships.scheduledInterval })
      .from(memberships).innerJoin(members, and(eq(members.id, memberships.memberId), eq(members.gymId, memberships.gymId)))
      .where(and(inArray(memberships.id, notice.membershipIds), eq(memberships.householdId, notice.householdId),
        eq(memberships.planId, notice.planId), ne(memberships.status, 'cancelled'), isNull(memberships.cancelledAt),
        eq(memberships.currency, notice.currency), eq(memberships.scheduledPlanId, notice.planId),
        eq(memberships.scheduledAmountCents, notice.amountCents), eq(memberships.scheduledOn, notice.effectiveOn),
        isNull(members.anonymizedAt))).orderBy(asc(memberships.id));
    if (!current.length) return { ok: false, reason: 'change_replaced' } as const;
    return { ok: true as const, recipient, plan, current };
  }

  return {
    async run(payload: unknown, gymId: string) {
      const notice = priceNoticePayload.parse(payload);
      if (!(await settings.get(gymId)).memberEmailsEnabled) { log(gymId, notice, 'disabled'); return; }
      const key = `plan-price:${notice.requestKey}:${notice.householdId}`;
      const digest = commandDigest([notice.planId, [...new Set(notice.membershipIds)].sort(), notice.amountCents, notice.currency, notice.effectiveOn]);
      const prepared = await scope(gymId, async tx => {
        const current = await read(tx, gymId, notice);
        if (!current.ok) return current;
        if (await deliveries.replay(tx, gymId, key, digest)) return { ok: false, reason: 'already_decided' } as const;
        return { ...current, reserved: await deliveries.reserve(tx, gymId, key, digest) };
      });
      if (!prepared.ok) { log(gymId, notice, prepared.reason); return; }
      let attempted = false, failure: { error: unknown } | undefined;
      let outcome: { status: 'sent' | 'suppressed' | 'failed'; reason?: string };
      try {
        if (demo && !options.demoEmailFor) throw new AppError('unavailable', 'Price notice demo outbox is not configured');
        const email = demo ? options.demoEmailFor!(gymId) : await options.mailer(gymId);
        if (!email) throw new AppError('unavailable', 'Price notice mail is not configured');
        const gymName = (await details.get(gymId)).name;
        // Mailer preparation may take time: reload the payer and pending changes at the last send boundary.
        const latest = await scope(gymId, tx => read(tx, gymId, notice));
        const gym = await settings.get(gymId);
        if (!latest.ok || !gym.memberEmailsEnabled) {
          await deliveries.release(prepared.reserved);
          log(gymId, notice, !latest.ok ? latest.reason : 'disabled'); return;
        }
        const message = await renderPriceChangeNotice({ gymName, planName: latest.plan.name, timezone: gym.timezone,
          effectiveOn: notice.effectiveOn, currency: notice.currency, amountCents: notice.amountCents,
          memberships: latest.current.map(member => ({ name: `${member.firstName} ${member.lastName}`, amountCents: member.amountCents,
            interval: z.enum(['monthly', 'annual']).parse(member.interval), newInterval: z.enum(['monthly', 'annual']).parse(member.newInterval) })) });
        attempted = true;
        const result = await deliveries.attempt(prepared.reserved, email, { to: latest.recipient.email, ...message });
        outcome = { status: result.status };
      } catch (error) {
        if (!attempted) { await deliveries.release(prepared.reserved); log(gymId, notice, 'not_attempted'); throw error; }
        // Record the attempt, including an uncertain one; only a proven non-send runs again when the job retries.
        failure = { error }; outcome = { status: 'failed', reason: deliveryAcceptance(error) };
      }
      log(gymId, notice, outcome.reason ?? outcome.status);
      await scope(gymId, tx => writeAudit(tx, { gymId, actorKind: 'system', action: 'billing.memberships.price_notice_decided',
        targetType: 'plan', targetId: notice.planId, after: { householdId: notice.householdId, ...outcome }, occurredAt: clock.now() }));
      if (failure) throw failure.error;
    },
  };
}
export type PriceNotice = ReturnType<typeof createPriceNotice>;
let configured: PriceNotice | undefined;
export function configurePriceNotice(service: PriceNotice) { configured = service; }
export function priceNotice(): PriceNotice {
  if (!configured) throw new AppError('unavailable', 'Price notices are not configured');
  return configured;
}

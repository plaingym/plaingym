// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import { auditEvents, forGym, households, invoices, members, memberships, paymentMethods, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, canStaff, type Clock, type Translator } from '@plaingym/shared';
import { dateSchema, extensionDashboardWidgetSchema, idSchema, terminalDisputeStatuses } from '@plaingym/shared/contracts';
import { addDays, localDate, zonedInstant } from '@plaingym/shared/time';
import { z } from 'zod';
import { clock as defaultClock } from '../../../core/clock.js';
import type { DashboardWidgetProvider } from '../../../core/interfaces/extensions.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import type { AccountService } from '../../../infra/auth/accounts.js';
import { createEmailDeliveries, deliveryAcceptance, type Email } from '../../../infra/email/index.js';
import type { JobContext, Jobs } from '../../../infra/jobs/index.js';
import { renderBillingAlert } from '../../../emails/billing/alerts.js';
import { createSignedLinksService } from '../../links/service.js';
import { unalertedDisputes } from './disputes.query.js';

export const sendAlertJob = 'billing.alerts.send';
// Default queue backoff: 1s doubling to a 24h cap. These budgets cover >31 days and >36 hours.
export const cardAlertMaxAttempts = 48;
export const disputeAlertMaxAttempts = 18;
export { terminalDisputeStatuses } from '@plaingym/shared/contracts';
const cardPayload = z.strictObject({ kind: z.literal('card_expiry'), paymentMethodId: idSchema, cycle: dateSchema });
const disputePayload = z.strictObject({ kind: z.literal('dispute'), invoiceId: idSchema, disputeId: z.string().min(1) });
const payloadSchema = z.discriminatedUnion('kind', [cardPayload, disputePayload]);
/** Job idempotency keys and durable send-state keys: both are kept permanently. */
const cardKey = (paymentMethodId: string, cycle: string) => `billing.alert.card_expiry:${paymentMethodId}:${cycle}`;
const disputeKey = (disputeId: string) => `billing.alert.dispute:${disputeId}`;
type Card = typeof paymentMethods.$inferSelect;
type AlertPayload = z.infer<typeof payloadSchema>;

/** Cards remain valid through their expiry month; billing dates are gym-local calendar dates. */
export function needsCardExpiryAlert(card: Pick<Card, 'expiryMonth' | 'expiryYear'>, cycle: string, today: string) {
  if (card.expiryMonth === null || card.expiryYear === null) return false;
  const expiresMonth = `${String(card.expiryYear).padStart(4, '0')}-${String(card.expiryMonth).padStart(2, '0')}`;
  return cycle.slice(0, 7) > expiresMonth && today >= addDays(cycle, -30) && today <= cycle;
}

export interface BillingAlertsOptions {
  scope?: typeof forGym;
  clock?: Clock;
  jobs: Jobs;
  settings: GymSettingsAccessor;
  accounts: Pick<AccountService, 'staffEmails'>;
  /** Runtime supplies the gym SMTP transport or demo outbox and its trusted canonical origin. */
  prepare(gymId: string): Promise<{ email: Email; origin: string; gymName?: string; locale?: string; t?: Translator }>;
}

export function createBillingAlerts(options: BillingAlertsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const links = createSignedLinksService({ scope, clock });
  const deliveries = createEmailDeliveries({ scope, clock });
  async function ready(gymId: string) {
    try {
      const prepared = await options.prepare(gymId);
      trustedOrigin(prepared.origin);
      return true;
    } catch {
      // Readiness must not consume the permanent delivery key. A later scan can try again.
      return false;
    }
  }
  async function cardForCycle(gymId: string, paymentMethodId: string, timezone: string) {
    return scope(gymId, async tx => {
      const [card] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.id, paymentMethodId),
        eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt)));
      if (!card) return;
      const [membership] = await tx.select({ cycle: memberships.nextDueOn }).from(memberships).where(and(
        eq(memberships.householdId, card.householdId), inArray(memberships.status, ['active', 'trial', 'pending']),
        gt(memberships.amountCents, 0))).orderBy(asc(memberships.nextDueOn)).limit(1);
      if (!membership || !needsCardExpiryAlert(card, membership.cycle, localDate(clock.now(), timezone))) return;
      const [household] = await tx.select({ email: households.email }).from(households).where(eq(households.id, card.householdId));
      const email = household?.email?.trim();
      if (!email) return;
      const family = await tx.select({ email: members.email, optOut: members.emailOptOut, deliverable: members.emailDeliverable })
        .from(members).where(eq(members.householdId, card.householdId));
      if (family.some(member => member.email?.trim().toLowerCase() === email.toLowerCase() && (member.optOut || !member.deliverable))) return;
      return { card, cycle: membership.cycle, email };
    });
  }
  async function cardExpiry(gymId: string) {
    const gym = await options.settings.get(gymId);
    if (!gym.memberEmailsEnabled) return;
    if (!await ready(gymId)) return;
    let cursor: string | undefined;
    for (;;) {
      const cards = await scope(gymId, tx => tx.select({ id: paymentMethods.id }).from(paymentMethods).where(and(
        eq(paymentMethods.isDefault, true), isNull(paymentMethods.revokedAt), cursor ? gt(paymentMethods.id, cursor) : undefined))
        .orderBy(asc(paymentMethods.id)).limit(100));
      for (const { id } of cards) {
        const candidate = await cardForCycle(gymId, id, gym.timezone);
        if (candidate) await options.jobs.enqueue(sendAlertJob,
          { kind: 'card_expiry', paymentMethodId: id, cycle: candidate.cycle } satisfies AlertPayload,
          { gymId, timezone: gym.timezone, idempotencyKey: cardKey(id, candidate.cycle),
            maxAttempts: cardAlertMaxAttempts });
      }
      if (cards.length < 100) return;
      cursor = cards.at(-1)!.id;
    }
  }
  async function disputes(gymId: string) {
    const gym = await options.settings.get(gymId);
    if (!await ready(gymId)) return;
    const owners = [...new Set((await options.accounts.staffEmails(gymId, ['owner'])).map(recipient))];
    if (!owners.length) return;
    let cursor: string | undefined;
    for (;;) {
      // Include already resolved disputes: an owner must still learn about one resolved between polls.
      const rows = await scope(gymId, tx => unalertedDisputes(tx, gymId, cursor));
      for (const row of rows) await options.jobs.enqueue(sendAlertJob,
        { kind: 'dispute', invoiceId: row.id, disputeId: row.disputeId! } satisfies AlertPayload,
        { gymId, timezone: gym.timezone, idempotencyKey: disputeKey(row.disputeId!),
          maxAttempts: disputeAlertMaxAttempts });
      if (rows.length < 100) return;
      cursor = rows.at(-1)!.id;
    }
  }
  const write = (tx: Transaction, gymId: string, kind: AlertPayload['kind'], targetId: string, after: Record<string, unknown>, outcome: string) =>
    writeAudit(tx, { gymId, actorKind: 'system', action: `billing.alert.${kind}.${outcome}`,
      targetType: kind === 'card_expiry' ? 'payment_method' : 'invoice', targetId, after, occurredAt: clock.now() });
  async function audit(gymId: string, kind: AlertPayload['kind'], targetId: string, after: Record<string, unknown>, outcome = 'sent') {
    await scope(gymId, tx => write(tx, gymId, kind, targetId, after, outcome));
  }
  /** Repairs an outcome audit a crash lost after the send state was recorded; `match` names the cycle or dispute. The
   * alert's card or invoice row is locked, so concurrent attempts write one audit between them. */
  async function auditOnce(gymId: string, kind: AlertPayload['kind'], targetId: string, match: Record<string, string>, outcome: string) {
    await scope(gymId, async tx => {
      if (kind === 'card_expiry') await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.id, targetId)).for('update');
      else await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.id, targetId)).for('update');
      const rows = await tx.select({ after: auditEvents.after }).from(auditEvents).where(and(
        eq(auditEvents.gymId, gymId), eq(auditEvents.action, `billing.alert.${kind}.${outcome}`), eq(auditEvents.targetId, targetId)));
      const [field, value] = Object.entries(match)[0]!;
      if (!rows.some(row => (row.after as Record<string, unknown> | null)?.[field] === value)) await write(tx, gymId, kind, targetId, match, outcome);
    });
  }
  async function send(payload: unknown, context: JobContext) {
    const work = payloadSchema.parse(payload), gymId = context.gymId;
    const gym = await options.settings.get(gymId);
    if (work.kind === 'card_expiry') {
      if (!gym.memberEmailsEnabled) return;
      let candidate = await cardForCycle(gymId, work.paymentMethodId, gym.timezone);
      if (!candidate || candidate.cycle !== work.cycle) return;
      // An accepted or possibly accepted notice is never sent again, so no second link is minted for it.
      const key = cardKey(work.paymentMethodId, work.cycle), sent = await deliveries.state(gymId, key);
      if (sent === 'sending') throw new Error('Card expiry alert is still being sent');
      if (sent === 'accepted') await auditOnce(gymId, work.kind, work.paymentMethodId, { cycle: work.cycle }, 'sent');
      if (sent === 'accepted' || sent === 'unknown') return;
      const prepared = await options.prepare(gymId), origin = trustedOrigin(prepared.origin);
      const created = await links.create({ gymId, actor: { kind: 'system' } }, {
        purpose: 'update_card', householdId: candidate.card.householdId,
        expiresAt: zonedInstant(addDays(work.cycle, 7), '09:00', gym.timezone, { gap: 'shift' })!.toISOString(),
      });
      const revoke = () => links.revoke({ gymId, actor: { kind: 'system' } }, created.link.id);
      let message;
      try {
        // Recheck after preparation/link creation too; a queued notice never follows an old default card.
        candidate = await cardForCycle(gymId, work.paymentMethodId, gym.timezone);
        if (!candidate || candidate.cycle !== work.cycle || !(await options.settings.get(gymId)).memberEmailsEnabled) {
          await revoke();
          return;
        }
        message = { to: recipient(candidate.email), ...await renderBillingAlert({ ...prepared, kind: 'cardExpiry', timezone: gym.timezone,
          dueOn: work.cycle, expiryMonth: candidate.card.expiryMonth!, expiryYear: candidate.card.expiryYear!,
          url: new URL(`/l/${created.token}`, origin).href }, prepared.t) };
      } catch (error) {
        await revoke();
        throw error;
      }
      let result;
      try {
        result = await deliveries.send(gymId, key, prepared.email, message);
      } catch (error) {
        // A possibly delivered link stays usable; it is never resent. Anything that provably did not send this
        // link (a refusal, a failed reservation, another attempt in flight) revokes it and retries.
        if (deliveryAcceptance(error) === 'not_accepted') await revoke();
        throw error;
      }
      // Suppressed, or another attempt holds the key: this link was never sent.
      if (result.status !== 'sent') {
        await revoke();
        // Another attempt's notice was accepted after this one's precheck: make sure its audit exists.
        if (result.status === 'skipped' && result.state === 'accepted')
          await auditOnce(gymId, work.kind, work.paymentMethodId, { cycle: work.cycle }, 'sent');
        return;
      }
      await audit(gymId, work.kind, work.paymentMethodId, { cycle: work.cycle, linkId: created.link.id });
    } else {
      const [invoice] = await scope(gymId, tx => tx.select().from(invoices).where(eq(invoices.id, work.invoiceId)));
      if (!invoice || invoice.disputeId !== work.disputeId) return;
      const owners = [...new Set((await options.accounts.staffEmails(gymId, ['owner'])).map(recipient))];
      if (!owners.length) throw new Error('No owner email configured for dispute alerts');
      const prepared = await options.prepare(gymId);
      const message = await renderBillingAlert({ ...prepared, kind: 'dispute', timezone: gym.timezone, number: invoice.number ?? invoice.id,
        disputeId: work.disputeId, status: invoice.disputeStatus ?? 'unknown',
        url: new URL('/admin/billing/invoices/' + invoice.id, trustedOrigin(prepared.origin)).href }, prepared.t);
      const identity = { disputeId: work.disputeId };
      let result;
      try {
        // One SMTP message addresses all owners; a partial acceptance is unknown and never resent.
        result = await deliveries.send(gymId, disputeKey(work.disputeId), prepared.email, { to: owners.join(', '), ...message });
      } catch (error) {
        if (deliveryAcceptance(error) === 'not_accepted') throw error;
        // Possibly delivered: never resent. The uncertain audit stops the scan from finding it again.
        await auditOnce(gymId, work.kind, invoice.id, identity, 'uncertain');
        return;
      }
      if (result.status === 'skipped') {
        // The recorded state outlived its audit (a crash in between): repair it so the scan stops.
        await auditOnce(gymId, work.kind, invoice.id, identity, result.state === 'accepted' ? 'sent' : 'uncertain');
        return;
      }
      if (result.status === 'suppressed') throw new Error('Dispute owner email was suppressed');
      await audit(gymId, work.kind, invoice.id, identity);
    }
  }
  return { cardExpiry, disputes, send };
}
export type BillingAlerts = ReturnType<typeof createBillingAlerts>;

function recipient(value: string): string {
  const email = value.trim();
  if (!/^[^\s@<>,;"\r\n\0]+@[^\s@<>,;"\r\n\0]+$/.test(email)) throw new Error('Invalid billing alert recipient');
  return email;
}
function trustedOrigin(value: string): URL {
  const origin = new URL(value);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash) throw new Error('Invalid billing alert origin');
  return origin;
}

/** The existing count renderer supports this extension; no UI or shared-contract change is needed. */
export function createDisputeAlertProvider(options: { scope?: typeof forGym } = {}): DashboardWidgetProvider<z.infer<typeof extensionDashboardWidgetSchema>> {
  const scope = options.scope ?? forGym;
  return { id: 'billing.disputes', permission: 'billing.read', order: 40, schema: extensionDashboardWidgetSchema,
    async read(context) {
      if (!canStaff(context.roles, 'billing.read')) throw new AppError('forbidden', 'Access denied');
      const [total] = await scope(context.gymId, tx => tx.select({ count: count() }).from(invoices).where(and(
        isNotNull(invoices.disputeId), or(isNull(invoices.disputeStatus), notInArray(invoices.disputeStatus, [...terminalDisputeStatuses])))));
      return { id: 'billing.disputes', titleKey: 'billing/alerts:disputesTitle', status: 'ready', kind: 'count', count: total!.count };
    },
  };
}

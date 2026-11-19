// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { forGym, invoices, smsDeliveries, type Transaction } from '@plaingym/db';
import { AppError, type Clock, type Translator } from '@plaingym/shared';
import { cardChargeIssue, formatMinorUnits } from '@plaingym/shared/money';
import type { CreateSignedLinkRequest } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as defaultClock } from '../../../core/clock.js';
import type { GymSettings, GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { createSmsDeliveries, deliveryAcceptance, MemberSms } from '../../../infra/sms/index.js';
import { createSignedLinksIn, revokeSignedLinkIn } from '../../links/service.js';
import { householdNoticePhones, type SmsRecipientGroup } from '../../members/sms-recipients.js';
import type { SmsResolver } from '../../settings/sms.js';
import { billingTranslator, trustedBillingOrigin, type TransitionNotice } from './notifications.js';

export interface BillingSmsOptions {
  scope?: typeof forGym;
  clock?: Clock;
  settings: GymSettingsAccessor;
  resolver: SmsResolver;
  /** The canonical gym origin, independent of whether SMTP is configured. */
  prepare(gymId: string): Promise<{ origin: string; t?: Translator; locale?: string }>;
}
interface SmsNotice {
  gymId: string;
  householdId: string;
  key(recipientId: string): string;
  eligible(tx: Transaction): Promise<boolean>;
  links(): CreateSignedLinkRequest[];
  body(t: Translator, urls: string[], locale?: string): string;
}
interface RememberedNotice { linkIds?: string[]; suppression?: 'cap_reached' | 'no_provider' }
/** Shared credential lifecycle for transition texts and card-expiry texts. */
export function createBillingSmsSender(options: BillingSmsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const deliveries = createSmsDeliveries({ scope, clock });
  return async function send(notice: SmsNotice, settings?: GymSettings): Promise<void> {
    assertNoTransaction('billing SMS notification');
    const { gymId, householdId } = notice;
    if (!(settings ?? await options.settings.get(gymId)).memberSmsEnabled) return;
    const context = { gymId, actor: { kind: 'system' as const } };
    // Select once, then reserve only the group about to send so a crash leaves later groups available.
    const groups = await scope(gymId, async tx => {
      if (!await notice.eligible(tx)) return [];
      return householdNoticePhones(tx, gymId, [householdId]);
    });
    let preparation: ReturnType<BillingSmsOptions['prepare']> | undefined;
    let failure: unknown;
    for (const group of groups) {
      const pending = await scope(gymId, async tx => {
        // Fallback phones use their consent holder; a billing phone uses its household, never its covered children.
        const key = notice.key(group.consentMemberIds[0] ?? householdId);
        const [previous] = await tx.select().from(smsDeliveries)
          .where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.key, key))).for('update');
        let old = previous?.commandResult as RememberedNotice | null;
        if (old?.suppression) {
          // A retry repairs cleanup only, even if SMTP or a different recipient made the enclosing effect fail.
          for (const id of old.linkIds ?? []) await revokeSignedLinkIn(tx, context, id, clock.now());
          return;
        }
        // An earlier group's send can outlast the notice: check again before reserving and minting for this one.
        if (!await notice.eligible(tx)) return;
        // Without a command digest, reserve's only conflict is an attempt still in flight.
        const reservation = await deliveries.reserve(tx, gymId, key).catch((error: unknown) => {
          if (error instanceof AppError && error.code === 'conflict') return error;
          throw error;
        });
        if (reservation instanceof AppError) return { inFlight: reservation };
        if (!reservation) return;
        // A competing first insertion may have settled while reserve waited on the unique key.
        if (!previous) {
          const [claimed] = await tx.select({ result: smsDeliveries.commandResult }).from(smsDeliveries)
            .where(eq(smsDeliveries.id, reservation.id));
          old = claimed?.result as RememberedNotice | null;
          if (old?.suppression) {
            for (const id of old.linkIds ?? []) await revokeSignedLinkIn(tx, context, id, clock.now());
            await tx.update(smsDeliveries).set({ state: 'not_accepted', updatedAt: clock.now() }).where(eq(smsDeliveries.id, reservation.id));
            return;
          }
        }
        for (const id of old?.linkIds ?? []) await revokeSignedLinkIn(tx, context, id, clock.now());
        const created = await createSignedLinksIn(tx, context, notice.links(), clock.now());
        await deliveries.remember(tx, reservation, { linkIds: created.map(item => item.link.id) });
        return { reservation, created };
      });
      if (!pending) continue;
      // Skip a group still in flight so the others proceed, but fail the effect: if that attempt ends in a
      // definite non-send, only a retry can send it.
      if ('inFlight' in pending) {
        failure ??= pending.inFlight;
        continue;
      }
      try {
        const current = async (tx: Transaction) => await notice.eligible(tx)
          ? (await householdNoticePhones(tx, gymId, [householdId])).find(candidate => sameRecipient(candidate, group)) : undefined;
        let attempted = false, cleaned = false;
        const cleanup = async () => {
          cleaned = true;
          const errors: unknown[] = [];
          try {
            await scope(gymId, async tx => {
              for (const item of pending.created) await revokeSignedLinkIn(tx, context, item.link.id, clock.now());
            });
          } catch (error) { errors.push(error); }
          try { await deliveries.release(pending.reservation); } catch (error) { errors.push(error); }
          if (errors.length) throw new AggregateError(errors, 'Billing SMS cleanup failed');
        };
        try {
          const prepared = await (preparation ??= options.prepare(gymId)), origin = trustedBillingOrigin(prepared.origin);
          const body = notice.body(billingTranslator(prepared.t), pending.created.map(item => new URL(`/l/${item.token}`, origin).href), prepared.locale);
          // The covered members are taken from this final check: one erased since selection would refuse the household's text.
          const latest = await scope(gymId, current);
          if (!latest) {
            await cleanup();
            continue;
          }
          const sms = new MemberSms({ ...options, scope, clock, gymId, kind: 'notices',
            memberIds: latest.consentHouseholdIds.length ? latest.memberIds : latest.consentMemberIds,
            householdIds: latest.consentHouseholdIds });
          attempted = true;
          const result = await deliveries.attempt(pending.reservation, {
            verifyAccount: () => sms.verifyAccount(),
            async sendSms(message) {
              const result = await sms.sendSms(message);
              if (result.status === 'suppressed' && (result.reason === 'cap_reached' || result.reason === 'no_provider')) {
                const suppression = result.reason;
                // Persist before `attempt` releases the key. A lost outcome or cleanup never permits a later text.
                await scope(gymId, tx => deliveries.remember(tx, pending.reservation, {
                  linkIds: pending.created.map(item => item.link.id), suppression,
                } satisfies RememberedNotice));
              }
              return result;
            },
          }, { to: group.phoneE164, body });
          if (result.status === 'suppressed') {
            await cleanup();
          }
        } catch (error) {
          if (!cleaned && (!attempted || deliveryAcceptance(error) === 'not_accepted')) {
            try { await cleanup(); }
            catch (cause) { throw new AggregateError([error, cause], 'Billing SMS and cleanup failed', { cause }); }
          }
          throw error;
        }
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  };
}
function sameRecipient(a: SmsRecipientGroup, b: SmsRecipientGroup) {
  return a.phoneE164 === b.phoneE164 && a.consentMemberIds.join(',') === b.consentMemberIds.join(',')
    && a.consentHouseholdIds.join(',') === b.consentHouseholdIds.join(',');
}

/** Receipt and dunning texts from persisted transition effects; staff resends call the email path only. */
export function createTransitionSmsNotifications(options: BillingSmsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock, send = createBillingSmsSender(options);
  async function deliver(notice: TransitionNotice, kind: 'receipt' | 'failed' | 'action') {
    const invoice = await scope(notice.gymId, async tx => (await tx.select().from(invoices)
      .where(and(eq(invoices.id, notice.invoice.id), eq(invoices.householdId, notice.invoice.householdId))))[0]);
    if (!invoice) return;
    const manual = kind !== 'receipt' && !!cardChargeIssue(invoice.amountCents, invoice.currency);
    await send({ gymId: notice.gymId, householdId: invoice.householdId,
      key: first => `billing.sms.${kind === 'receipt' ? 'receipt' : 'dunning'}:${invoice.id}:${notice.generation}:${first}`,
      eligible: async tx => !!(await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.id, invoice.id),
        eq(invoices.householdId, invoice.householdId), kind === 'receipt' ? undefined : inArray(invoices.status, ['open', 'past_due']))))[0],
      links: () => {
        if (kind === 'receipt' || manual) return [];
        const fields = { householdId: invoice.householdId, expiresAt: new Date(clock.now().getTime() + 21 * 86400_000).toISOString() };
        return [{ ...fields, purpose: 'pay_invoice', invoiceId: invoice.id }, { ...fields, purpose: 'update_card' }];
      },
      body: (t, urls) => t(`billing/sms:${manual ? 'manual' : kind}`, { number: invoice.number ?? invoice.id,
        amount: formatMinorUnits(notice.payment?.invoiceId === invoice.id ? notice.payment.amountCents : invoice.amountCents, invoice.currency),
        payUrl: urls[0] ?? '', updateUrl: urls[1] ?? '' }),
    });
  }
  return {
    receipt: (notice: TransitionNotice) => deliver(notice, 'receipt'),
    dunning: (notice: TransitionNotice & { actionRequired: boolean }) => deliver(notice, notice.actionRequired ? 'action' : 'failed'),
  };
}

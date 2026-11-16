// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { forGym, invoices, smsDeliveries, type Transaction } from '@plaingym/db';
import { createTranslator, type Clock, type Translator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { cardChargeIssue, formatMinorUnits } from '@plaingym/shared/money';
import type { CreateSignedLinkRequest } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as defaultClock } from '../../../core/clock.js';
import type { GymSettingsAccessor } from '../../../core/interfaces/gym-settings.js';
import { createSmsDeliveries, deliveryAcceptance, DeliveryError, MemberSms } from '../../../infra/sms/index.js';
import { createSignedLinksIn, revokeSignedLinkIn } from '../../links/service.js';
import { householdNoticePhones, type SmsRecipientGroup } from '../../members/sms-recipients.js';
import type { SmsResolver } from '../../settings/sms.js';
import type { TransitionNotice } from './notifications.js';

const english = createTranslator(locales.en ?? {});
export interface BillingSmsOptions {
  scope?: typeof forGym;
  clock?: Clock;
  settings: GymSettingsAccessor;
  resolver: SmsResolver;
  /** The canonical gym origin, independent of whether SMTP is configured. */
  prepare(gymId: string): Promise<{ origin: string; t?: Translator }>;
}
interface SmsNotice {
  gymId: string;
  householdId: string;
  key(recipientId: string): string;
  eligible(tx: Transaction): Promise<boolean>;
  links(): CreateSignedLinkRequest[];
  body(t: Translator, urls: string[]): string;
}
/** Shared credential lifecycle for transition texts and card-expiry texts. */
export function createBillingSmsSender(options: BillingSmsOptions) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const deliveries = createSmsDeliveries({ scope, clock });
  return async function send(notice: SmsNotice): Promise<void> {
    assertNoTransaction('billing SMS notification');
    const { gymId, householdId } = notice;
    if (!(await options.settings.get(gymId)).memberSmsEnabled) return;
    const groups = await scope(gymId, async tx => await notice.eligible(tx) ? householdNoticePhones(tx, gymId, [householdId]) : []);
    let failure: unknown;
    for (const group of groups) {
      try {
        // Fallback members, rather than the covered children, distinguish two billing-contact phones. The billing phone
        // is keyed by its household, which (unlike the covered children) can't change between retries.
        const first = group.consentMemberIds[0] ?? householdId;
        const key = notice.key(first), context = { gymId, actor: { kind: 'system' as const } };
        const current = async (tx: Transaction) => await notice.eligible(tx)
          ? (await householdNoticePhones(tx, gymId, [householdId])).find(candidate => sameRecipient(candidate, group)) : undefined;
        const pending = await scope(gymId, async tx => {
          if (!await current(tx)) return;
          const reservation = await deliveries.reserve(tx, gymId, key);
          if (!reservation) return;
          // Repair cleanup lost after a proven non-send before minting another credential.
          const [previous] = await tx.select({ result: smsDeliveries.commandResult }).from(smsDeliveries)
            .where(and(eq(smsDeliveries.gymId, gymId), eq(smsDeliveries.id, reservation.id)));
          const old = previous?.result as { linkIds?: string[] } | null;
          for (const id of old?.linkIds ?? []) await revokeSignedLinkIn(tx, context, id, clock.now());
          const created = await createSignedLinksIn(tx, context, notice.links(), clock.now());
          await deliveries.remember(tx, reservation, { linkIds: created.map(item => item.link.id) });
          return { reservation, created };
        });
        if (!pending) continue;
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
          const prepared = await options.prepare(gymId), origin = new URL(prepared.origin);
          if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
            throw new Error('Invalid billing SMS origin');
          const t: Translator = (key, values) => {
            const translated = prepared.t?.(key, values);
            return translated && translated !== key ? translated : english(key, values);
          };
          const body = notice.body(t, pending.created.map(item => new URL(`/l/${item.token}`, origin).href));
          // The covered members are taken from this final check: one erased since selection would refuse the household's text.
          const latest = (await options.settings.get(gymId)).memberSmsEnabled ? await scope(gymId, current) : undefined;
          if (!latest) {
            await cleanup();
            continue;
          }
          const sms = new MemberSms({ ...options, scope, clock, gymId, kind: 'notices',
            memberIds: latest.consentHouseholdIds.length ? latest.memberIds : latest.consentMemberIds,
            householdIds: latest.consentHouseholdIds });
          attempted = true;
          const result = await deliveries.attempt(pending.reservation, sms, { to: group.phoneE164, body });
          if (result.status === 'suppressed') {
            await cleanup();
            if (result.reason === 'cap_reached' || result.reason === 'no_provider')
              throw new DeliveryError('not_accepted', 'Billing SMS temporarily suppressed');
          }
        } catch (error) {
          if (!cleaned && (!attempted || deliveryAcceptance(error) === 'not_accepted')) await cleanup();
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

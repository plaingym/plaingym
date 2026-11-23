// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, paymentMethods, uuidv7 } from '@plaingym/db';
import { createTranslator, type Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import { locales } from '@plaingym/shared/locales';
import type { JobRegistration } from '../../core/registry.js';
import { withJobTransaction, type Jobs } from '../../infra/jobs/index.js';
import { CardCursorRefused, CardImportRefused, type CustomerCardPage, type PaymentMethod, type PaymentMethodType, type Payments } from '../../infra/payments/index.js';
import { readGymSettings } from '../settings/settings.js';
import { catalogAudit } from './catalog.js';
import { loadHousehold } from './payments.js';
import { stripeWriteCurrent } from './stripe-writes.js';
import { promoteDefaultCard } from './payments.mutations.js';

export const customerCardImportJob = 'billing.payments.import_customer_cards';
export const customerCardChunkSize = 100;
export const customerCardRestartLimit = 3;
const t = createTranslator(locales.en ?? {});
const cursorSchema = z.string().regex(/^[A-Za-z0-9_]+$/);
const payloadSchema = z.strictObject({ householdId: idSchema, customerId: z.string().regex(/^[A-Za-z0-9_]+$/),
  requestId: idSchema, switched: idSchema.nullable(), cursor: cursorSchema.nullish(), skippedCursor: cursorSchema.nullish(),
  currency: z.string().optional(),
  restarts: z.number().int().min(0).max(customerCardRestartLimit).default(0),
  importedCards: z.number().int().nonnegative().default(0), importedBankAccounts: z.number().int().nonnegative().default(0),
  skippedCards: z.number().int().nonnegative().default(0), skippedBankAccounts: z.number().int().nonnegative().default(0),
  skippedMandatePermissions: z.number().int().nonnegative().default(0) });
export interface CustomerCardImportOptions {
  scope?: typeof forGym;
  clock: Clock;
  jobs: Jobs;
  paymentsFor(gymId: string): Promise<Payments | null>;
}

export function bankAccountType(currency: string): Exclude<PaymentMethodType, 'card'> | null {
  if (currency === 'USD') return 'us_bank_account';
  if (currency === 'CAD') return 'acss_debit';
  return null;
}

export function importedBankDetails(method: Exclude<PaymentMethod, { type: 'card' }>) {
  return { type: method.type, bankName: method.bankName ?? null, last4: method.last4,
    mandateId: method.mandateId ?? null, processorCreatedAt: method.createdAt };
}

function validatePage(page: CustomerCardPage, customerId: string, cursor: string | null | undefined, types: readonly PaymentMethodType[]) {
  const skipped = page.skippedForeign ?? [];
  // A mixed listing, and a bank listing that drops an account without masked digits, can continue from a method it filtered out.
  // A card-only listing continues from its last card or its last method tagged for another gym or household.
  if (page.cards.length + skipped.length > customerCardChunkSize || page.nextCursor === cursor
    || types.length === 1 && types[0] === 'card' && page.nextCursor !== null
      && page.nextCursor !== page.cards.at(-1)?.id && page.nextCursor !== skipped.at(-1)?.id)
    throw new Error('Invalid card pagination');
  if (page.cards.some(method => method.customerId !== customerId || !Number.isFinite(method.createdAt.getTime()) || !types.includes(method.type))
    || skipped.some(method => !types.includes(method.type) || page.cards.some(card => card.id === method.id)))
    throw new Error('Imported payment method identity is unresolved');
}

/** Runtime-configured factory: a page and its continuation commit together, so crashes can replay safely. */
export function createCustomerCardImportJobs(options: CustomerCardImportOptions): readonly JobRegistration[] {
  const scope = options.scope ?? forGym;
  return [{ id: customerCardImportJob, lane: 'batch', async handler(input, context) {
    const payload = payloadSchema.parse(input), { gymId } = context;
    const actor = { gymId, actor: { kind: 'system' as const } };
    const committedCounts = { importedCards: payload.importedCards, importedBankAccounts: payload.importedBankAccounts,
      skippedCards: payload.skippedCards, ...(payload.skippedBankAccounts ? { skippedBankAccounts: payload.skippedBankAccounts } : {}),
      ...(payload.skippedMandatePermissions ? { skippedMandatePermissions: payload.skippedMandatePermissions } : {}) };
    async function outcome(reason: string, restart = false) {
      await withJobTransaction(scope, gymId, async transaction => {
        const { tx } = transaction;
        const current = await stripeWriteCurrent(tx, gymId, payload.switched)
          && (await loadHousehold(tx, payload.householdId, true)).stripeCustomerId === payload.customerId;
        const restarting = current && restart && payload.restarts < customerCardRestartLimit;
        // Settle the cards already committed when the bounded restart budget ends.
        if (current && restart && !restarting)
          await promoteDefaultCard(tx, actor, options.clock, payload.householdId, context.timezone, payload.requestId);
        const restartLimitReason = reason === 'listing_changed' ? 'listing_changed_restart_limit' : 'cursor_restart_limit';
        await catalogAudit(tx, actor, options.clock, restarting ? 'billing.card.import_restarted' : 'billing.card.import_finished',
          'household', payload.householdId, undefined, { requestId: payload.requestId,
            outcome: restarting ? 'restarted' : current && restart ? 'refused' : 'stale',
            reason: !current ? 'customer_or_configuration_changed' : restart && !restarting ? restartLimitReason : reason,
            ...committedCounts, restarts: payload.restarts });
        if (restarting) {
          const next = { ...payload }; delete next.cursor; delete next.skippedCursor; delete next.currency;
          // Start both listings again. Committed methods already counted in this request remain counted.
          await options.jobs.enqueue(customerCardImportJob, { ...next, restarts: payload.restarts + 1, skippedCards: 0,
            skippedBankAccounts: 0, skippedMandatePermissions: 0 },
            { gymId, timezone: context.timezone, idempotencyKey: `${payload.requestId}:restart:${payload.restarts + 1}`, maxAttempts: 8 }, transaction);
        }
      });
    }
    const currency = await scope(gymId, async tx => {
      if (!await stripeWriteCurrent(tx, gymId, payload.switched)
        || (await loadHousehold(tx, payload.householdId)).stripeCustomerId !== payload.customerId) return null;
      return (await readGymSettings(tx, gymId)).currency;
    });
    if (!currency) { await outcome('customer_or_configuration_changed'); return; }
    if (payload.currency && payload.currency !== currency) {
      await outcome('listing_changed', true); return;
    }
    const provider = await options.paymentsFor(gymId);
    if (!provider) throw new Error('Card import payments are unavailable');
    // A continuation queued by the card-only importer still has a cursor in that listing.
    const legacyCardListing = !!payload.cursor && payload.currency === undefined;
    const bankType = legacyCardListing ? null : bankAccountType(currency);
    const types: PaymentMethodType[] = bankType ? ['card', bankType] : ['card'];
    const otherBankType = bankType === 'us_bank_account' ? 'acss_debit' : 'us_bank_account';
    const list = async (types: readonly PaymentMethodType[], cursor: string | null | undefined, includeMandates = false) => {
      if (cursor === null) return { cards: [], nextCursor: null };
      const page = await provider.listCustomerCards(payload.customerId, { householdId: payload.householdId, types,
        limit: customerCardChunkSize, ...(cursor ? { cursor } : {}), ...(includeMandates ? { includeMandates } : {}) });
      validatePage(page, payload.customerId, cursor, types);
      return page;
    };
    let page: CustomerCardPage, skippedPage: CustomerCardPage;
    try {
      page = await list(types, payload.cursor, bankType === 'acss_debit');
      // The eligible listing filters out the other bank type. Page through it separately to count skips.
      skippedPage = await list([otherBankType], bankType ? payload.skippedCursor : null);
    } catch (error) {
      if (error instanceof CardImportRefused) { await outcome('ownership_refused'); return; }
      if (error instanceof CardCursorRefused && (payload.cursor || payload.skippedCursor)) { await outcome('cursor_refused', true); return; }
      throw error;
    }
    const pageOutcome = await withJobTransaction(scope, gymId, async transaction => {
      const { tx } = transaction;
      const configurationCurrent = await stripeWriteCurrent(tx, gymId, payload.switched);
      const household = await loadHousehold(tx, payload.householdId, true);
      // Customer replacement, erasure and a test-to-live switch must not restore stale card references.
      if (!configurationCurrent || household.stripeCustomerId !== payload.customerId) {
        await catalogAudit(tx, actor, options.clock, 'billing.card.import_finished', 'household', household.id, undefined,
          { requestId: payload.requestId, outcome: 'stale', reason: 'customer_or_configuration_changed',
            ...committedCounts, restarts: payload.restarts });
        return;
      }
      if ((await readGymSettings(tx, gymId)).currency !== currency) return 'listing_changed';
      let skippedCards = payload.skippedCards;
      // The other bank type's listing is skipped whole, including any method tagged elsewhere.
      let skippedBankAccounts = payload.skippedBankAccounts + skippedPage.cards.length + (skippedPage.skippedForeign?.length ?? 0);
      let skippedMandatePermissions = payload.skippedMandatePermissions;
      let { importedCards, importedBankAccounts } = payload;
      for (const method of page.skippedForeign ?? []) {
        if (method.type === 'card') skippedCards++;
        else skippedBankAccounts++;
        await catalogAudit(tx, actor, options.clock, 'billing.card.import_skipped', 'household', household.id, undefined,
          { requestId: payload.requestId, processorId: method.id, reason: 'tagged_elsewhere' });
      }
      // One lookup per chunk keeps the transaction short while it holds the gym settings and household locks.
      const stored = new Map(page.cards.length === 0 ? [] : (await tx.select({ processorId: paymentMethods.processorId,
        id: paymentMethods.id, householdId: paymentMethods.householdId, type: paymentMethods.type, last4: paymentMethods.last4,
        revokedAt: paymentMethods.revokedAt, processorCreatedAt: paymentMethods.processorCreatedAt }).from(paymentMethods)
        .where(inArray(paymentMethods.processorId, page.cards.map(card => card.id)))).map(row => [row.processorId, row]));
      for (const method of page.cards) {
        const isCard = method.type === 'card';
        const row = stored.get(method.id);
        if (row !== undefined) {
          if (row.householdId !== household.id) {
            if (isCard) skippedCards++;
            else skippedBankAccounts++;
            await catalogAudit(tx, actor, options.clock, 'billing.card.import_skipped', 'household', household.id, undefined,
              { requestId: payload.requestId, processorId: method.id, reason: 'another_household' });
          } else if (method.type === 'card' && row.type === 'card' && row.revokedAt === null && row.last4 === null) {
            // A card saved by ID alone (a people CSV) gets its details; its default and removal state stay as they are.
            // The conditions are repeated in the update, so a row removed or filled since the lookup stays as it is.
            const [filled] = await tx.update(paymentMethods).set({ brand: method.brand ?? null, last4: method.last4,
              expiryMonth: method.expiresMonth, expiryYear: method.expiresYear,
              processorCreatedAt: row.processorCreatedAt ?? method.createdAt })
              .where(and(eq(paymentMethods.id, row.id), eq(paymentMethods.type, 'card'), isNull(paymentMethods.revokedAt),
                isNull(paymentMethods.last4)))
              .returning({ id: paymentMethods.id });
            if (filled) await catalogAudit(tx, actor, options.clock, 'billing.card.import_details_filled', 'payment_method', row.id,
              undefined, { householdId: household.id, requestId: payload.requestId });
          }
          continue; // Includes revoked rows: importing is never consent to restore a removed card.
        }
        if (method.type === 'acss_debit' && !method.mandateId) {
          skippedBankAccounts++;
          if (method.mandateReadDenied) skippedMandatePermissions++;
          await catalogAudit(tx, actor, options.clock, 'billing.card.import_skipped', 'household', household.id, undefined,
            { requestId: payload.requestId, processorId: method.id,
              reason: method.mandateReadDenied ? 'mandate_read_denied' : 'mandate_unavailable' });
          continue;
        }
        const id = uuidv7();
        const details = isCard
          ? { brand: method.brand ?? null, last4: method.last4, expiryMonth: method.expiresMonth,
            expiryYear: method.expiresYear, processorCreatedAt: method.createdAt }
          : importedBankDetails(method);
        stored.set(method.id, { processorId: method.id, id, householdId: household.id, type: method.type,
          last4: details.last4, revokedAt: null, processorCreatedAt: details.processorCreatedAt });
        await tx.insert(paymentMethods).values({ id, gymId, householdId: household.id, processorId: method.id,
          ...details, createdAt: options.clock.now(), isDefault: false });
        if (isCard) importedCards++;
        else importedBankAccounts++;
        await catalogAudit(tx, actor, options.clock, 'billing.card.imported', 'payment_method', id, undefined,
          { householdId: household.id, requestId: payload.requestId });
      }
      if (!page.nextCursor && !skippedPage.nextCursor) {
        await promoteDefaultCard(tx, actor, options.clock, household.id, context.timezone, payload.requestId);
        const imported = importedBankAccounts || skippedBankAccounts
          ? t('billing/customer-card-import:summary', {
            cards: t('billing/customer-card-import:' + (importedCards === 1 ? 'card' : 'cards'), { count: importedCards }),
            bankAccounts: t('billing/customer-card-import:' + (importedBankAccounts === 1 ? 'bankAccount' : 'bankAccounts'), { count: importedBankAccounts }),
          }) : undefined;
        const bankSummary = imported === undefined ? {} : { importedCards, importedBankAccounts, skippedBankAccounts,
          ...(skippedMandatePermissions ? { skippedMandatePermissions } : {}),
          summary: skippedMandatePermissions
            ? t('billing/customer-card-import:summaryWithMandateReadSkips', { imported, count: skippedMandatePermissions }) : imported };
        await catalogAudit(tx, actor, options.clock, 'billing.card.import_finished', 'household', household.id, undefined,
          { requestId: payload.requestId, outcome: 'finished', skippedCards, restarts: payload.restarts, ...bankSummary });
      }
      if (page.nextCursor || skippedPage.nextCursor) await options.jobs.enqueue(customerCardImportJob,
        { ...payload, ...(legacyCardListing ? {} : { currency }), importedCards, importedBankAccounts, skippedCards, skippedBankAccounts,
          skippedMandatePermissions, cursor: page.nextCursor, skippedCursor: skippedPage.nextCursor },
        { gymId, timezone: context.timezone, idempotencyKey: `${payload.requestId}:${payload.restarts}:${page.nextCursor ?? ''}:${skippedPage.nextCursor ?? ''}`,
          maxAttempts: 8 }, transaction);
    });
    if (pageOutcome === 'listing_changed') await outcome(pageOutcome, true);
  } }];
}

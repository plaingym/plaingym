// SPDX-License-Identifier: AGPL-3.0-only
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, paymentMethods, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import type { JobRegistration } from '../../core/registry.js';
import { withJobTransaction, type Jobs } from '../../infra/jobs/index.js';
import { CardCursorRefused, CardImportRefused, type Payments } from '../../infra/payments/index.js';
import { catalogAudit } from './catalog.js';
import { loadHousehold } from './payments.js';
import { stripeWriteCurrent } from './stripe-writes.js';
import { promoteDefaultCard } from './payments.mutations.js';

export const customerCardImportJob = 'billing.payments.import_customer_cards';
export const customerCardChunkSize = 100;
export const customerCardRestartLimit = 3;
const payloadSchema = z.strictObject({ householdId: idSchema, customerId: z.string().regex(/^[A-Za-z0-9_]+$/),
  requestId: idSchema, switched: idSchema.nullable(), cursor: z.string().regex(/^[A-Za-z0-9_]+$/).optional(),
  restarts: z.number().int().min(0).max(customerCardRestartLimit).default(0), skippedCards: z.number().int().nonnegative().default(0) });
export interface CustomerCardImportOptions {
  scope?: typeof forGym;
  clock: Clock;
  jobs: Jobs;
  paymentsFor(gymId: string): Promise<Payments | null>;
}

/** Runtime-configured factory: a page and its continuation commit together, so crashes can replay safely. */
export function createCustomerCardImportJobs(options: CustomerCardImportOptions): readonly JobRegistration[] {
  const scope = options.scope ?? forGym;
  return [{ id: customerCardImportJob, lane: 'batch', async handler(input, context) {
    const payload = payloadSchema.parse(input), { gymId } = context;
    const actor = { gymId, actor: { kind: 'system' as const } };
    async function outcome(reason: string, restart = false) {
      await withJobTransaction(scope, gymId, async transaction => {
        const { tx } = transaction;
        const current = await stripeWriteCurrent(tx, gymId, payload.switched)
          && (await loadHousehold(tx, payload.householdId, true)).stripeCustomerId === payload.customerId;
        const restarting = current && restart && payload.restarts < customerCardRestartLimit;
        // A cursor refusal must still settle the cards already committed when the bounded restart budget ends.
        if (current && restart && !restarting)
          await promoteDefaultCard(tx, actor, options.clock, payload.householdId, context.timezone, payload.requestId);
        await catalogAudit(tx, actor, options.clock, restarting ? 'billing.card.import_restarted' : 'billing.card.import_finished',
          'household', payload.householdId, undefined, { requestId: payload.requestId,
            outcome: restarting ? 'restarted' : current && restart ? 'refused' : 'stale',
            reason: !current ? 'customer_or_configuration_changed' : restart && !restarting ? 'cursor_restart_limit' : reason,
            skippedCards: payload.skippedCards, restarts: payload.restarts });
        if (restarting) {
          const next = { ...payload }; delete next.cursor;
          // The restart lists from the first page again, so it counts skipped cards afresh.
          await options.jobs.enqueue(customerCardImportJob, { ...next, restarts: payload.restarts + 1, skippedCards: 0 },
            { gymId, timezone: context.timezone, idempotencyKey: `${payload.requestId}:restart:${payload.restarts + 1}`, maxAttempts: 8 }, transaction);
        }
      });
    }
    const current = await scope(gymId, async tx => {
      if (!await stripeWriteCurrent(tx, gymId, payload.switched)) return false;
      return (await loadHousehold(tx, payload.householdId)).stripeCustomerId === payload.customerId;
    });
    if (!current) { await outcome('customer_or_configuration_changed'); return; }
    const provider = await options.paymentsFor(gymId);
    if (!provider) throw new Error('Card import payments are unavailable');
    let page;
    try {
      page = await provider.listCustomerCards(payload.customerId, { householdId: payload.householdId,
        limit: customerCardChunkSize, ...(payload.cursor ? { cursor: payload.cursor } : {}) });
    } catch (error) {
      if (error instanceof CardImportRefused) { await outcome('ownership_refused'); return; }
      if (error instanceof CardCursorRefused && payload.cursor) { await outcome('cursor_refused', true); return; }
      throw error;
    }
    if (page.cards.length > customerCardChunkSize || page.nextCursor === payload.cursor
      || page.nextCursor !== null && page.nextCursor !== page.cards.at(-1)?.id) throw new Error('Invalid card pagination');
    if (page.cards.some(card => card.customerId !== payload.customerId || !Number.isFinite(card.createdAt.getTime())))
      throw new Error('Imported card identity is unresolved');
    await withJobTransaction(scope, gymId, async transaction => {
      const { tx } = transaction;
      const configurationCurrent = await stripeWriteCurrent(tx, gymId, payload.switched);
      const household = await loadHousehold(tx, payload.householdId, true);
      // Customer replacement, erasure and a test-to-live switch must not restore stale card references.
      if (!configurationCurrent || household.stripeCustomerId !== payload.customerId) {
        await catalogAudit(tx, actor, options.clock, 'billing.card.import_finished', 'household', household.id, undefined,
          { requestId: payload.requestId, outcome: 'stale', reason: 'customer_or_configuration_changed',
            skippedCards: payload.skippedCards, restarts: payload.restarts });
        return;
      }
      let skippedCards = payload.skippedCards;
      // One lookup per chunk keeps the transaction short while it holds the gym settings and household locks.
      const stored = new Map(page.cards.length === 0 ? [] : (await tx.select({ processorId: paymentMethods.processorId,
        householdId: paymentMethods.householdId }).from(paymentMethods)
        .where(inArray(paymentMethods.processorId, page.cards.map(card => card.id)))).map(row => [row.processorId, row.householdId]));
      for (const card of page.cards) {
        const owner = stored.get(card.id);
        if (owner !== undefined) {
          if (owner !== household.id) {
            skippedCards++;
            await catalogAudit(tx, actor, options.clock, 'billing.card.import_skipped', 'household', household.id, undefined,
              { requestId: payload.requestId, processorId: card.id, reason: 'another_household' });
          }
          continue; // Includes revoked rows: importing is never consent to restore a removed card.
        }
        stored.set(card.id, household.id);
        const id = uuidv7();
        await tx.insert(paymentMethods).values({ id, gymId, householdId: household.id, processorId: card.id,
          brand: card.brand ?? null, last4: card.last4, expiryMonth: card.expiresMonth, expiryYear: card.expiresYear,
          processorCreatedAt: card.createdAt, createdAt: options.clock.now(), isDefault: false });
        await catalogAudit(tx, actor, options.clock, 'billing.card.imported', 'payment_method', id, undefined,
          { householdId: household.id, requestId: payload.requestId });
      }
      if (!page.nextCursor) {
        await promoteDefaultCard(tx, actor, options.clock, household.id, context.timezone, payload.requestId);
        await catalogAudit(tx, actor, options.clock, 'billing.card.import_finished', 'household', household.id, undefined,
          { requestId: payload.requestId, outcome: 'finished', skippedCards, restarts: payload.restarts });
      }
      if (page.nextCursor) await options.jobs.enqueue(customerCardImportJob, { ...payload, skippedCards, cursor: page.nextCursor },
        { gymId, timezone: context.timezone, idempotencyKey: `${payload.requestId}:${payload.restarts}:${page.nextCursor}`, maxAttempts: 8 }, transaction);
    });
  } }];
}

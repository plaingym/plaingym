// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { forGym, paymentMethods, uuidv7 } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { idSchema } from '@plaingym/shared/contracts';
import type { JobRegistration } from '../../core/registry.js';
import { withJobTransaction, type Jobs } from '../../infra/jobs/index.js';
import type { Payments } from '../../infra/payments/index.js';
import { catalogAudit } from './catalog.js';
import { loadHousehold } from './payments.js';
import { stripeWriteCurrent } from './stripe-writes.js';

export const customerCardImportJob = 'billing.payments.import_customer_cards';
export const customerCardChunkSize = 100;
const payloadSchema = z.strictObject({ householdId: idSchema, customerId: z.string().regex(/^[A-Za-z0-9_]+$/),
  requestId: idSchema, switched: idSchema.nullable(), cursor: z.string().regex(/^[A-Za-z0-9_]+$/).optional() });
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
    const current = await scope(gymId, async tx => {
      if (!await stripeWriteCurrent(tx, gymId, payload.switched)) return false;
      return (await loadHousehold(tx, payload.householdId)).stripeCustomerId === payload.customerId;
    });
    if (!current) return;
    const provider = await options.paymentsFor(gymId);
    if (!provider) throw new Error('Card import payments are unavailable');
    const page = await provider.listCustomerCards(payload.customerId, { householdId: payload.householdId,
      limit: customerCardChunkSize, ...(payload.cursor ? { cursor: payload.cursor } : {}) });
    if (page.cards.length > customerCardChunkSize || page.nextCursor === payload.cursor
      || page.nextCursor !== null && page.nextCursor !== page.cards.at(-1)?.id) throw new Error('Invalid card pagination');
    if (page.cards.some(card => card.customerId !== payload.customerId || !Number.isFinite(card.createdAt.getTime())))
      throw new Error('Imported card identity is unresolved');
    await withJobTransaction(scope, gymId, async transaction => {
      const { tx } = transaction;
      if (!await stripeWriteCurrent(tx, gymId, payload.switched)) return;
      const household = await loadHousehold(tx, payload.householdId, true);
      // Customer replacement, erasure and a test-to-live switch must not restore stale card references.
      if (household.stripeCustomerId !== payload.customerId) return;
      const actor = { gymId, actor: { kind: 'system' as const } };
      // One lookup per chunk keeps the transaction short while it holds the gym settings and household locks.
      const stored = new Map(page.cards.length === 0 ? [] : (await tx.select({ processorId: paymentMethods.processorId,
        householdId: paymentMethods.householdId }).from(paymentMethods)
        .where(inArray(paymentMethods.processorId, page.cards.map(card => card.id)))).map(row => [row.processorId, row.householdId]));
      for (const card of page.cards) {
        const owner = stored.get(card.id);
        if (owner !== undefined) {
          if (owner !== household.id) throw new Error('Imported card belongs to another household');
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
      const active = and(eq(paymentMethods.householdId, household.id), isNull(paymentMethods.revokedAt));
      const [currentDefault] = await tx.select({ id: paymentMethods.id }).from(paymentMethods)
        .where(and(active, eq(paymentMethods.isDefault, true))).limit(1);
      if (!currentDefault && !page.nextCursor) {
        // All pages are stored before choosing: provider creation time, then ID, as collection does.
        const [newest] = await tx.select({ id: paymentMethods.id }).from(paymentMethods)
          .where(and(active, isNotNull(paymentMethods.processorCreatedAt)))
          .orderBy(desc(paymentMethods.processorCreatedAt), desc(paymentMethods.processorId)).limit(1);
        const replacement = newest ?? (await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(active)
          .orderBy(desc(paymentMethods.createdAt), desc(paymentMethods.id)).limit(1))[0];
        if (replacement) {
          await tx.update(paymentMethods).set({ isDefault: true }).where(eq(paymentMethods.id, replacement.id));
          await catalogAudit(tx, actor, options.clock, 'billing.card.default_changed', 'payment_method', replacement.id, undefined,
            { householdId: household.id, requestId: payload.requestId });
        }
      }
      if (page.nextCursor) await options.jobs.enqueue(customerCardImportJob, { ...payload, cursor: page.nextCursor },
        { gymId, timezone: context.timezone, idempotencyKey: `${payload.requestId}:${page.nextCursor}`, maxAttempts: 8 }, transaction);
    });
  } }];
}

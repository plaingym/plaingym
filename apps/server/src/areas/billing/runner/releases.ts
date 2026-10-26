// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, invoices } from '@plaingym/db';
import type { MutationContext } from '../../../core/interfaces/common.js';
import type { Payments } from '../../../infra/payments/index.js';
import type { createReconciliation } from './reconciliation.js';

type Reconciliation = Pick<ReturnType<typeof createReconciliation>, 'apply' | 'checkout'>;
export async function releaseActionNeeded(gymId: string, intentId: string, provider: Payments,
  reconciliation: Reconciliation, context: MutationContext): Promise<'released' | 'paid'> {
  const outcome = await provider.cancelCharge(intentId);
  if (!await reconciliation.apply(gymId, outcome, context)) throw new Error('Action-needed intent remains unresolved');
  if (outcome.status === 'succeeded') return 'paid';
  if (outcome.status !== 'failed' || outcome.code !== 'canceled') throw new Error('Action-needed intent was not cancelled');
  return 'released';
}

export async function releaseCheckout(gymId: string, invoiceId: string, sessionId: string, provider: Payments,
  reconciliation: Reconciliation, scope: typeof forGym, context: MutationContext): Promise<'released' | 'paid' | 'changed'> {
  await provider.expireCheckout(sessionId);
  if (!await reconciliation.checkout(gymId, sessionId, provider, context)) {
    const current = await scope(gymId, async tx => (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]);
    if (current?.checkoutSessionId !== sessionId) return 'changed';
    throw new Error('Checkout must be reconciled before collecting payment');
  }
  const current = await scope(gymId, async tx => (await tx.select().from(invoices).where(eq(invoices.id, invoiceId)))[0]);
  if (current && ['paid', 'partially_refunded', 'refunded'].includes(current.status)) return 'paid';
  if (current?.checkoutSessionId) return 'changed';
  return 'released';
}

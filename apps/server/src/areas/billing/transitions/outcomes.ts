// SPDX-License-Identifier: AGPL-3.0-only
import { conflict } from '../../../core/interfaces/common.js';
import type { MutationContext } from '../../../core/interfaces/common.js';
import type { InvoiceTransitions } from '../../../core/interfaces/invoice-transitions.js';
import type { ChargeOutcome } from '../../../infra/payments/index.js';

/** Both the runner and webhook dispatcher pass the provider's normalized, current outcome here. */
export async function applyChargeOutcome(transitions: InvoiceTransitions, context: MutationContext,
  identity: { invoiceId: string; paymentId: string; attemptId?: string; chargeId?: string; paidAt: string }, outcome: ChargeOutcome) {
  if (outcome.status === 'unknown' || outcome.status === 'pending') return null;
  if (outcome.metadata.gymId !== context.gymId || outcome.metadata.invoiceId !== identity.invoiceId
    || (outcome.metadata.attemptId && outcome.metadata.attemptId !== identity.attemptId)) conflict('Payment outcome identity mismatch');
  if (outcome.status === 'succeeded') {
    if (!identity.chargeId) conflict('Successful payment requires its processor Charge ID');
    return transitions.cardSucceeded(context, { ...identity, chargeId: identity.chargeId, paymentIntentId: outcome.id,
      amountCents: outcome.amount, currency: outcome.currency.toUpperCase() as 'USD' | 'CAD' });
  }
  if (!identity.attemptId) conflict('Failed payment requires its attempt ID');
  return transitions.cardFailed(context, { invoiceId: identity.invoiceId, attemptId: identity.attemptId,
    paymentIntentId: outcome.id, outcome: outcome.status === 'action_required' ? 'requires_action'
      : outcome.code === 'canceled' ? 'canceled' : 'failed' });
}

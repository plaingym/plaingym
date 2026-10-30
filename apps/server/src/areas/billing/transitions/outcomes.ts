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
    const chargeId = identity.chargeId ?? outcome.latestChargeId;
    if (!chargeId) conflict('Successful payment requires its processor Charge ID');
    return transitions.cardSucceeded(context, { ...identity, chargeId, paymentIntentId: outcome.id,
      amountCents: outcome.amount, currency: outcome.currency.toUpperCase() as 'USD' | 'CAD' });
  }
  if (!identity.attemptId) conflict('Failed payment requires its attempt ID');
  const failure = { invoiceId: identity.invoiceId, attemptId: identity.attemptId, paymentIntentId: outcome.id };
  if (outcome.status === 'action_required') return transitions.cardFailed(context, { ...failure, outcome: 'requires_action' });
  if (outcome.code !== 'canceled') return transitions.cardFailed(context, { ...failure, outcome: 'failed' });
  // A cancelled intent with a Charge was confirmed and declined before the cancellation (a lost response, then a
  // cancel): record the decline first, so the cancellation can't pass for one that never reached the card.
  const declined = outcome.latestChargeId ? await transitions.cardFailed(context, { ...failure, outcome: 'failed' }) : undefined;
  const canceled = await transitions.cardFailed(context, { ...failure, outcome: 'canceled' });
  return declined?.outcome === 'applied' ? declined : canceled;
}

// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import type { SkipReason } from './runner/eligibility.js';

const skipMessages = {
  billing_disabled: 'Billing is disabled', not_payable: 'Invoice is not payable', needs_review: 'Release the review hold before charging a card',
  pending_attempt: 'The card payment is still being resolved; check back shortly', no_saved_card: 'An active default card and Stripe customer are required',
  already_attempted: 'Automatic collection has already been attempted', outside_retry_window: 'Invoice is outside the retry window',
  not_auto_collectable: 'Invoice cannot be collected automatically', not_due: 'Invoice is not due yet',
  checkout_changed: 'Checkout changed during collection; reload the invoice', reservation_lost: 'The charge reservation changed; check back shortly',
  action_required: 'The existing card payment needs authentication', collection_changed: 'Invoice, customer or saved card changed before confirmation',
} satisfies Record<SkipReason, string>;
export function chargeSkipped(reason: SkipReason): never { return paymentConflict(reason, skipMessages[reason]); }
export function paymentConflict(reason: string, message: string): never { throw new AppError('conflict', message, { reason: [reason] }); }
export function paymentUnavailable(reason: string, message: string): never { throw new AppError('unavailable', message, { reason: [reason] }); }

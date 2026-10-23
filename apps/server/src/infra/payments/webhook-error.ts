// SPDX-License-Identifier: AGPL-3.0-only
export type WebhookErrorCode = 'webhook_not_for_gym' | 'webhook_invalid';

/** Inbox routing failures; provider lookup errors keep their original retryable identity. */
export class PaymentWebhookError extends Error {
  constructor(readonly code: WebhookErrorCode) {
    super(code === 'webhook_not_for_gym' ? 'Stripe event is not for this gym' : 'Invalid Stripe webhook');
    this.name = 'PaymentWebhookError';
  }
}

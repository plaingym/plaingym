// SPDX-License-Identifier: AGPL-3.0-only

/** `not_accepted` is proof that no recipient received the message; anything less is `unknown`. */
export type DeliveryAcceptance = 'not_accepted' | 'unknown';
/**
 * Provider-neutral send failure. The message never quotes recipients or server replies. It lives apart from
 * `index.ts` so `smtp.ts` can subclass it: `index.ts` re-exports `smtp.ts`, so a subclass that imported it from
 * there would be built before the base class exists.
 */
export class DeliveryError extends Error {
  override readonly name = 'DeliveryError';
  /** Mirrors `acceptance` so structured logs, which record error codes only, show the classification. */
  readonly code: DeliveryAcceptance;
  constructor(readonly acceptance: DeliveryAcceptance, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = acceptance;
  }
}

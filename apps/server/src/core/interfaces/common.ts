// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { idSchema, instantSchema, moneySchema, revisionSchema } from '@plaingym/shared/contracts';
import type { Id, IsoInstant, Money, Revision } from '@plaingym/shared/contracts';

/** Implementations audit mutations in the same short transaction as the write. */
export interface MutationContext {
  readonly gymId: Id;
  readonly actor: { readonly kind: 'user'; readonly userId: Id } | { readonly kind: 'system' };
}
export function scopedKey(gymId: Id, id: Id): string {
  return JSON.stringify([idSchema.parse(gymId), idSchema.parse(id)]);
}
export function notFound(): never { throw new AppError('not_found', 'Resource not found'); }
export function conflict(message: string): never { throw new AppError('conflict', message); }
export function requireRevision(actual: Revision, expected: Revision): void {
  revisionSchema.parse(expected);
  if (actual !== expected) conflict('The record has changed; reload before saving.');
}
export function requireMoney(actual: Money, expected: Money): void {
  moneySchema.parse({ amountCents: expected.amountCents, currency: expected.currency });
  if (actual.currency !== expected.currency || actual.amountCents !== expected.amountCents)
    conflict('Payment amount or currency does not match');
}
export function instant(value: IsoInstant): number { return Date.parse(instantSchema.parse(value)); }

// SPDX-License-Identifier: AGPL-3.0-only
import type { AppliedMembershipDiscount, Discount } from '@plaingym/shared/contracts';
import { formatMinorUnits } from '@plaingym/shared/money';
import { ApiError } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { basisPointsToPercent } from './percent.js';
import { revisionConflict } from '../catalog/format.js';
export { revisionConflict } from '../catalog/format.js';

export const text = (key: string, values?: Record<string, string | number>) => t('billing/discount-screens:' + key, values);
const reasons = new Set(['discount_unknown', 'discount_ended', 'discount_used_up', 'discount_plan', 'membership_changed',
  'membership_cancelled', 'membership_erased', 'membership_fee_only', 'membership_no_discount', 'discount_scheduled_plan']);
const catalogReasons: Record<string, string> = { discount_duplicate: 'duplicate', discount_terms_used: 'termsUsed',
  discount_max_uses: 'maxUses', discount_currency_mismatch: 'currencyMismatch' };
export function failure(error: unknown) {
  if (error instanceof ApiError) {
    const reason = error.reason.find(code => reasons.has(code));
    if (reason) return t('billing/discounts:' + reason);
    const catalogReason = error.reason.find(code => Object.hasOwn(catalogReasons, code));
    if (catalogReason) return t('billing/discounts:' + catalogReasons[catalogReason]);
    if (revisionConflict(error)) return text('conflict');
    if (error.status === 409) return text('refused');
  }
  return text('failed');
}
export function benefit(row: Pick<Discount | AppliedMembershipDiscount, 'percentBasisPoints' | 'amountCents' | 'currency' | 'waivesSignupFee'>) {
  const parts = [];
  if (row.percentBasisPoints !== null) parts.push(text('percentOff', { percent: basisPointsToPercent(row.percentBasisPoints) }));
  if (row.amountCents !== null) parts.push(text('amountOff', { amount: formatMinorUnits(row.amountCents, row.currency) }));
  if (row.waivesSignupFee) parts.push(text('signupWaived'));
  return parts.join(' · ');
}

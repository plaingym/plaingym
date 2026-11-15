// SPDX-License-Identifier: AGPL-3.0-only
import { formatMinorUnits } from '@plaingym/shared/money';
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';

export { amountInputPattern, amountInputStep, minorUnitsToInput, parseMinorUnits } from '@plaingym/shared/money';
export const text = (key: string) => t('billing/catalog:' + key);
/** A catalog message with values. */
export const say = (key: string, values: Record<string, string | number>) => t('billing/catalog:' + key, values);
export const selectClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base';
/** A non-negative decimal with up to `places` fraction digits as an integer of 10^-places units (tax rates; prices use parseMinorUnits). */
export function decimalUnits(value: string, places: number) {
  if (!new RegExp('^[0-9]+(?:[.][0-9]{1,' + places + '})?$').test(value)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  if (units > 2_147_483_647n) throw new Error('Amount is too large');
  return Number(units);
}
/** An amount in `currency`'s minor units for display. */
export const money = (value: number, currency: string) => formatMinorUnits(value, currency);
export const revisionConflict = (error: unknown) => error instanceof ApiError && error.status === 409
  && error.reason.some(reason => reason === 'revision_conflict' || reason === 'membership_changed');
export function saveError(error: unknown, creating = false) {
  if (error instanceof ApiError && error.status === 409) {
    if (revisionConflict(error)) return text(creating ? 'createConflict' : 'conflict');
    if (error.reason.includes('currency_mismatch')) return text('currencyMismatch');
    if (error.reason.includes('tax_inactive')) return text('taxInactive');
    if (error.reason.includes('tax_rate_attached')) return text('taxAttachedConflict');
    return text('saveRefused');
  }
  return text('error');
}

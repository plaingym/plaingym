// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';

export const text = (key: string) => t('billing/catalog:' + key);
export const selectClass = 'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base';
export function decimalUnits(value: string, places: number) {
  if (!new RegExp('^[0-9]+(?:[.][0-9]{1,' + places + '})?$').test(value)) throw new Error('Invalid amount');
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  if (units > 2_147_483_647n) throw new Error('Amount is too large');
  return Number(units);
}
export const decimalAmount = (value: number) => (value / 100).toFixed(2);
export const money = (value: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(value / 100);
export const saveError = (error: unknown) => text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');

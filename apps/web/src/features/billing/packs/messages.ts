// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '../../../lib/i18n.js';
import { ApiError } from '../../../lib/api.js';

export const text = (key: string, values?: Record<string, string | number>) => t('billing/pack-screens:' + key, values);
export function failure(error: unknown) {
  if (error instanceof ApiError) {
    if (error.reason.includes('currency_mismatch')) return text('currencyMismatch');
    if (error.reason.includes('tax_inactive')) return text('taxInactive');
    if (error.reason.includes('insufficient_credits')) return text('insufficient');
    if (error.reason.includes('adjustment_id_reused')) return text('reused');
    if (error.status === 409) return text('refused');
  }
  return text('error');
}

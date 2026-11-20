// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { t } from './i18n.js';
import { paymentMethodLabel } from './card-brand.js';

const adminText = (key: string, values?: Record<string, string | number>) => t('billing/payments:' + key, values);

it('keeps the existing card fallback when the network and last four digits are unavailable', () => {
  expect(paymentMethodLabel({ type: 'card', brand: null, bankName: null, last4: null }, adminText))
    .toBe('Card · Card details unavailable');
});

it.each([
  { bankName: 'Example Bank', expected: 'Example Bank account' },
  { bankName: null, expected: 'Bank account' },
])('uses an account label without a suffix when the bank reports no last four digits ($expected)', ({ bankName, expected }) => {
  expect(paymentMethodLabel({ type: 'us_bank_account', brand: null, bankName, last4: null }, adminText)).toBe(expected);
});

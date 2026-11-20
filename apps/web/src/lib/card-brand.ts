// SPDX-License-Identifier: AGPL-3.0-only
import type { Translator } from '@plaingym/shared';
import type { MaskedPaymentMethod } from '@plaingym/shared/contracts';

/** Card networks as people write them; the payment provider stores them lowercase (`visa`, `amex`). */
const names: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club',
  jcb: 'JCB', unionpay: 'UnionPay', cartes_bancaires: 'Cartes Bancaires', eftpos_au: 'eftpos', interac: 'Interac',
};
/** A saved card's network for display: its usual name, or the stored value when it isn't a known one. */
function cardBrand(brand: string): string {
  return names[brand.toLowerCase()] ?? brand;
}

export function paymentMethodLabel(method: Pick<MaskedPaymentMethod, 'type' | 'brand' | 'bankName' | 'last4'>, t: Translator): string {
  if (method.type === 'card') {
    return t('cardLabel', { brand: method.brand ? cardBrand(method.brand) : t('card'), last4: method.last4 ?? t('unknownCard') });
  }
  if (method.bankName) {
    return method.last4 ? t('namedBankEnding', { bankName: method.bankName, last4: method.last4 })
      : t('namedBankAccount', { bankName: method.bankName });
  }
  return method.last4 ? t('bankEnding', { last4: method.last4 }) : t('bankAccount');
}

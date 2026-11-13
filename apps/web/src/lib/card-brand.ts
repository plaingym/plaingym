// SPDX-License-Identifier: AGPL-3.0-only
/** Card networks as people write them; the payment provider stores them lowercase (`visa`, `amex`). */
const names: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club',
  jcb: 'JCB', unionpay: 'UnionPay', cartes_bancaires: 'Cartes Bancaires', eftpos_au: 'eftpos', interac: 'Interac',
};
/** A saved card's network for display: its usual name, or the stored value when it isn't a known one. */
export function cardBrand(brand: string): string {
  return names[brand.toLowerCase()] ?? brand;
}

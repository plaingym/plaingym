// SPDX-License-Identifier: AGPL-3.0-only
/** Integer cents as an amount in `currency`, in the given locale. Each caller keeps its own locale. */
export const formatMoney = (cents: number, currency: string, locale = 'en') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);

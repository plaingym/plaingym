// SPDX-License-Identifier: AGPL-3.0-only
/** Format document quantities with the same locale as the document's amounts. */
export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

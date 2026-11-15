// SPDX-License-Identifier: AGPL-3.0-only
/** Display counts use the browser locale; keep form values and identifiers numeric. */
export function formatCount(value: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

// SPDX-License-Identifier: AGPL-3.0-only
/** Display counts use the same fixed English locale as money and dates. */
const counts = new Intl.NumberFormat('en');
export function formatCount(value: number): string {
  return counts.format(value);
}

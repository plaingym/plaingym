// SPDX-License-Identifier: AGPL-3.0-only
/** Percentages are decimal strings; keep basis-point precision without floating-point rounding. */
export function percentToBasisPoints(value: string) {
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid percentage');
  const [whole, fraction = ''] = value.split('.');
  const result = Number(whole + fraction.padEnd(2, '0'));
  if (result < 1 || result > 10_000) throw new Error('Invalid percentage');
  return result;
}
export function basisPointsToPercent(value: number) {
  const digits = String(value).padStart(3, '0'), fraction = digits.slice(-2).replace(/0+$/, '');
  return digits.slice(0, -2) + (fraction ? '.' + fraction : '');
}

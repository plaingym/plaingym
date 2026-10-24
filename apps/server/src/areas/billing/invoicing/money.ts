// SPDX-License-Identifier: AGPL-3.0-only
const MAX_CENTS = 2_147_483_647n;

export function nonnegativeInteger(value: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new RangeError('Invalid ' + name);
  return value;
}
export function cents(value: number): number { return nonnegativeInteger(value, Number(MAX_CENTS), 'amount in cents'); }
export function checkedCents(value: bigint): number {
  if (value < 0n || value > MAX_CENTS) throw new RangeError('Invoice amount exceeds integer cents range');
  return Number(value);
}
/** Round nonnegative rational amounts to the nearest cent, ties upward. */
export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) throw new RangeError('Invalid money ratio');
  return (2n * numerator + denominator) / (2n * denominator);
}
/** Exact largest-remainder allocation; array order breaks equal-remainder ties. */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = weights.reduce((value, weight) => value + weight, 0n);
  if (sum === 0n) {
    if (total !== 0n) throw new RangeError('Cannot allocate to zero weights');
    return weights.map(() => 0n);
  }
  const shares = weights.map((weight, index) => ({ index, amount: total * weight / sum, remainder: total * weight % sum }));
  let remaining = total - shares.reduce((value, share) => value + share.amount, 0n);
  const ranked = [...shares].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const share of ranked) {
    if (remaining === 0n) break;
    share.amount++; remaining--;
  }
  return shares.map((share) => share.amount);
}

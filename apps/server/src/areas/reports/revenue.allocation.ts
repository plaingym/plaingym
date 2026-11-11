// SPDX-License-Identifier: AGPL-3.0-only
export interface AllocationPart { readonly id: string; readonly amount: number }
const integer = (amount: number) => {
  if (!Number.isSafeInteger(amount)) throw new RangeError('Allocation requires safe integer minor units');
  return BigInt(amount);
};

/** Signed largest remainder: negative discount weights stay negative; ties use line IDs. */
export function allocateRevenue(amount: number, weights: readonly AllocationPart[]): AllocationPart[] {
  const target = integer(amount);
  if (target < 0n) throw new RangeError('Allocation target must be nonnegative');
  if (new Set(weights.map(part => part.id)).size !== weights.length) throw new RangeError('Duplicate allocation ID');
  const denominator = weights.reduce((sum, part) => sum + integer(part.amount), 0n);
  if (denominator <= 0n) {
    if (target === 0n) return weights.map(part => ({ id: part.id, amount: 0 }));
    throw new RangeError('Allocation weights must have a positive total');
  }
  const parts = weights.map(part => {
    const numerator = target * integer(part.amount);
    // BigInt division truncates toward zero; Hamilton allocation needs floor even for discounts.
    const remainder = ((numerator % denominator) + denominator) % denominator;
    return { id: part.id, amount: (numerator - remainder) / denominator, remainder };
  });
  const remaining = target - parts.reduce((sum, part) => sum + part.amount, 0n);
  const ranked = [...parts].sort((a, b) => a.remainder === b.remainder
    ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < Number(remaining); index++) ranked[index]!.amount++;
  return parts.map(part => {
    const value = Number(part.amount);
    integer(value);
    return { id: part.id, amount: value };
  });
}

/** Only the invoice amount is attributed to lines; excess (or an unaccepted payment) is unapplied. */
export function allocatePayment(amount: number, invoiceAmount: number, lines: readonly AllocationPart[], accepted = true): AllocationPart[] {
  integer(amount); integer(invoiceAmount);
  if (amount < 0 || invoiceAmount < 0) throw new RangeError('Payment and invoice amounts must be nonnegative');
  const applied = accepted && lines.length ? Math.min(amount, invoiceAmount) : 0;
  const parts = applied ? allocateRevenue(applied, lines) : lines.map(line => ({ id: line.id, amount: 0 }));
  return [...parts, { id: 'unapplied', amount: amount - applied }];
}

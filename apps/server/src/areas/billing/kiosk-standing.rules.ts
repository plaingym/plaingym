// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, lt, or } from 'drizzle-orm';
import { invoices } from '@plaingym/db';

export function isOverdueInvoice(row: { amountCents: number; status: string; dueOn: string }, today: string): boolean {
  return row.amountCents > 0 && (row.status === 'past_due' || row.status === 'open' && row.dueOn < today);
}
/** SQL counterpart of isOverdueInvoice; the PostgreSQL parity test covers both predicates. */
export function overdueInvoiceCondition(today: string) {
  return and(gt(invoices.amountCents, 0), or(eq(invoices.status, 'past_due'),
    and(eq(invoices.status, 'open'), lt(invoices.dueOn, today))));
}

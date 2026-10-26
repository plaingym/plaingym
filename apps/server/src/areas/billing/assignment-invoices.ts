// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, exists, notExists, notInArray } from 'drizzle-orm';
import { invoiceLineItems, invoices, type Transaction } from '@plaingym/db';

const assignmentLineKinds = ['membership', 'signup_fee', 'discount', 'tax'];
/** Correlated to the outer invoice, with the same line rules as isAssignmentInvoice. */
export function assignmentInvoiceCondition(tx: Transaction) {
  const lines = () => tx.select({ id: invoiceLineItems.id }).from(invoiceLineItems);
  const sameInvoice = and(eq(invoiceLineItems.gymId, invoices.gymId), eq(invoiceLineItems.invoiceId, invoices.id));
  return and(exists(lines().where(sameInvoice)),
    notExists(lines().where(and(sameInvoice, notInArray(invoiceLineItems.kind, assignmentLineKinds)))));
}
export async function isAssignmentInvoice(tx: Transaction, invoiceId: string) {
  const lines = await tx.select({ kind: invoiceLineItems.kind }).from(invoiceLineItems).where(eq(invoiceLineItems.invoiceId, invoiceId));
  return lines.length > 0 && lines.every(line => assignmentLineKinds.includes(line.kind));
}

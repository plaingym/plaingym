// SPDX-License-Identifier: AGPL-3.0-only
import type { Transaction } from './client.js';
import { auditEvents } from './schema/activity.js';
/** The service supplies occurredAt from its injected clock and redacts secrets before calling. */
export async function writeAudit(tx: Transaction, event: typeof auditEvents.$inferInsert) {
  const [row] = await tx.insert(auditEvents).values(event).returning();
  return row!;
}

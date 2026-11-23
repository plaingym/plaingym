// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray } from 'drizzle-orm';
import { auditEvents, type Transaction } from '@plaingym/db';

/**
 * When this record's number last replied STOP, or null once a later consent change or number change ended it.
 * The caller's transaction already scopes the gym; only the date of the opt-out leaves this read.
 * The portal's `smsOptedOut` household query uses the same actions and order; change both together.
 */
export async function readSmsOptedOut(tx: Transaction, type: 'member' | 'household', id: string): Promise<string | null> {
  const optedOut = type + '.sms_opted_out';
  const [row] = await tx.select({ action: auditEvents.action, occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.targetType, type), eq(auditEvents.targetId, id),
      inArray(auditEvents.action, [optedOut, type + '.sms_consent_changed', type + '.sms_number_changed'])))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  return row?.action === optedOut ? row.occurredAt.toISOString() : null;
}

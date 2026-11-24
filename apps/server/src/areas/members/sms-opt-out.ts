// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, isNull, notExists } from 'drizzle-orm';
import { auditEvents, households, members, smsOptedOutNumbers, type Transaction } from '@plaingym/db';

/**
 * When this record's number last replied STOP, or null once a later consent change or number change ended it;
 * or, with no opt-out of its own and no stored consent, when this number is on the gym's opted-out list.
 * The caller's transaction already scopes the gym; only the date of the opt-out leaves this read.
 * The portal's `smsOptedOut` household query uses the same actions, order and fallback; change both together. It looks
 * the list up only by the stored number, while the staff reads pass the number as read for a record with none stored.
 */
export async function readSmsOptedOut(tx: Transaction, type: 'member' | 'household', id: string, phoneE164: string): Promise<string | null> {
  const optedOut = type + '.sms_opted_out';
  const [row] = await tx.select({ action: auditEvents.action, occurredAt: auditEvents.occurredAt }).from(auditEvents)
    .where(and(eq(auditEvents.targetType, type), eq(auditEvents.targetId, id),
      inArray(auditEvents.action, [optedOut, type + '.sms_consent_changed', type + '.sms_number_changed'])))
    .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(1);
  if (row?.action === optedOut) return row.occurredAt.toISOString();
  if (type === 'member') {
    const [consent] = await tx.select({ notices: members.smsNoticesConsentAt, announcements: members.smsAnnouncementsConsentAt })
      .from(members).where(eq(members.id, id));
    if (consent?.notices || consent?.announcements) return null;
  } else {
    const [consent] = await tx.select({ notices: households.smsNoticesConsentAt })
      .from(households).where(eq(households.id, id));
    if (consent?.notices) return null;
  }
  const [listed] = await tx.select({ optedOutAt: smsOptedOutNumbers.optedOutAt }).from(smsOptedOutNumbers)
    .where(eq(smsOptedOutNumbers.phoneE164, phoneE164));
  return listed ? listed.optedOutAt.toISOString() : null;
}

/** Consent recorded for a number takes it off the gym's opted-out list, in the transaction that records it. */
export async function clearSmsOptOut(tx: Transaction, phoneE164: string | null): Promise<void> {
  if (phoneE164 === null) return;
  await tx.delete(smsOptedOutNumbers).where(eq(smsOptedOutNumbers.phoneE164, phoneE164));
}

/**
 * Drops the number from the gym's opted-out list once no current member and no household holds it. Callers run it
 * after their own write to the record. It locks the number's row first, so of two writes that each move one of its last
 * holders away, the later one checks again after the earlier commits and the row never outlives both.
 */
export async function forgetUnheldSmsOptOut(tx: Transaction, phoneE164: string | null): Promise<void> {
  if (phoneE164 === null) return;
  const [row] = await tx.select({ phoneE164: smsOptedOutNumbers.phoneE164 }).from(smsOptedOutNumbers)
    .where(eq(smsOptedOutNumbers.phoneE164, phoneE164)).for('update');
  if (!row) return;
  await tx.delete(smsOptedOutNumbers).where(and(eq(smsOptedOutNumbers.phoneE164, phoneE164),
    notExists(tx.select({ id: members.id }).from(members).where(and(eq(members.phoneE164, phoneE164), isNull(members.anonymizedAt)))),
    notExists(tx.select({ id: households.id }).from(households).where(eq(households.phoneE164, phoneE164)))));
}

// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { auditEvents, type Transaction } from '@plaingym/db';
import { localDate } from '@plaingym/shared/time';

export const campaignDeliveryActions = ['link_campaign.delivery_reserved', 'link_campaign.delivery_sent',
  'link_campaign.delivery_queued', 'billing.card_setup.started', 'billing.checkout.started'] as const;
export type DeliveryHistory = Pick<typeof auditEvents.$inferSelect, 'targetId' | 'action' | 'after' | 'occurredAt'>[];

/** One indexed query per recipient batch; these records must survive at least until link expiry. */
export function deliveryHistory(tx: Transaction, gymId: string, linkIds: string[]): Promise<DeliveryHistory> {
  return tx.select({ targetId: auditEvents.targetId, action: auditEvents.action, after: auditEvents.after, occurredAt: auditEvents.occurredAt })
    .from(auditEvents).where(and(eq(auditEvents.gymId, gymId), inArray(auditEvents.action, [...campaignDeliveryActions]), inArray(auditEvents.targetId, linkIds)));
}
export function deliveryBlocked(history: DeliveryHistory, linkId: string, occurrence: string, now: Date, timezone: string, includeQueued = false) {
  const today = localDate(now, timezone);
  return history.some(row => {
    if (row.targetId !== linkId) return false;
    if (row.action === 'billing.card_setup.started' || row.action === 'billing.checkout.started')
      return row.occurredAt.getTime() > now.getTime() - 24 * 60 * 60 * 1000;
    const sameOccurrence = (row.after as { occurrence?: string } | null)?.occurrence === occurrence;
    if (row.action === 'link_campaign.delivery_queued') return includeQueued && sameOccurrence;
    return sameOccurrence || localDate(row.occurredAt, timezone) === today;
  });
}

export function checkoutInProgress(history: DeliveryHistory, linkId: string, now: Date) {
  return history.some(row => row.targetId === linkId
    && (row.action === 'billing.card_setup.started' || row.action === 'billing.checkout.started')
    && row.occurredAt.getTime() > now.getTime() - 24 * 60 * 60 * 1000);
}

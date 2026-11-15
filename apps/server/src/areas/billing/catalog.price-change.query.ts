// SPDX-License-Identifier: AGPL-3.0-only
// eslint-disable-next-line database/system-tables -- Isolated parameterized lock and JSON audit predicates; callers use only their gym's forGym transaction.
import { sql } from 'drizzle-orm';
import { auditEvents, type Transaction } from '@plaingym/db';

export const priceRequestKey = () => sql<string>`${auditEvents.after}->'request'->>'requestKey'`;
export const priceResultKey = () => sql<string>`${auditEvents.after}->>'requestKey'`;
export const priceSchedulePlan = () => sql<string>`${auditEvents.after}->>'planId'`;
/** Null-safe JSON comparisons: an ordinary edit supersedes a cycle price only when price terms changed. */
export const priceTermsEdited = () => sql`(${auditEvents.before}->'amountCents' IS DISTINCT FROM ${auditEvents.after}->'amountCents'
  OR ${auditEvents.before}->'interval' IS DISTINCT FROM ${auditEvents.after}->'interval')`;

/** Serialize this gym's use of a key across plans before taking a plan row lock. */
export async function lockPriceRequest(tx: Transaction, gymId: string, requestKey: string) {
  // eslint-disable-next-line database/system-tables -- Transaction-scoped advisory lock only, with the gym and request key bound as data.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'billing.plan.price_change:' + gymId + ':' + requestKey}, 0))`);
}

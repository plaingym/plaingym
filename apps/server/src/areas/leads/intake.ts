// SPDX-License-Identifier: AGPL-3.0-only
import { leads, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import type { LeadSource } from '@plaingym/shared/contracts';

/** Records the first intake only, with its audit in the caller's gym transaction. */
export async function recordLeadIntake(tx: Transaction, input: {
  gymId: string; memberId: string; source: LeadSource; now: Date;
}) {
  const [lead] = await tx.insert(leads).values({ id: uuidv7(input.now.getTime()), gymId: input.gymId, memberId: input.memberId,
    source: input.source, createdAt: input.now }).onConflictDoNothing({ target: [leads.gymId, leads.memberId] })
    .returning({ id: leads.id });
  if (lead) await writeAudit(tx, { gymId: input.gymId, actorKind: 'system', action: 'lead.created',
    targetType: 'lead', targetId: lead.id, after: { source: input.source }, occurredAt: input.now });
}

// SPDX-License-Identifier: AGPL-3.0-only
import type { Transaction } from './client.js';
import { auditEvents } from './schema/activity.js';

/** Actor identities are structural so database helpers need no dependency on server interfaces. */
export function auditActor(actor: { kind: 'user'; userId: string } | { kind: 'device'; deviceId: string } | { kind: 'system' }) {
  return { actorKind: actor.kind,
    ...(actor.kind === 'user' ? { actorUserId: actor.userId } : {}),
    ...(actor.kind === 'device' ? { actorDeviceId: actor.deviceId } : {}) };
}
/** The service supplies occurredAt from its injected clock and redacts secrets before calling. */
export async function writeAudit(tx: Transaction, event: typeof auditEvents.$inferInsert) {
  const [row] = await tx.insert(auditEvents).values(event).returning();
  return row!;
}

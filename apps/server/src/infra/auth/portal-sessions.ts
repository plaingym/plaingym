// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { authSession, householdUsers, writeAudit, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import { AppError, type Clock } from '@plaingym/shared';
import type { BoundSession } from './service.js';

/** Stores the portal household a session has chosen. It is a preference, never an authorization:
 * the principal loader checks it against the user's current household links on every request. */
export function createPortalSessionStore(database = systemDatabase) {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  return {
    async select(gymId: string, session: Pick<BoundSession, 'sessionId' | 'userId'>, householdId: string, clock: Clock) {
      await forGym(gymId, async tx => {
        const [login] = await tx.select({ id: householdUsers.id, scope: householdUsers.scope, memberId: householdUsers.memberId }).from(householdUsers)
          .where(and(eq(householdUsers.userId, session.userId), eq(householdUsers.householdId, householdId))).for('share');
        if (!login || (login.scope !== 'payer' && (login.scope !== 'member' || !login.memberId))) throw new AppError('not_found', 'Household not found');
        const [updated] = await tx.update(authSession).set({ householdId }).where(and(eq(authSession.id, session.sessionId),
          eq(authSession.userId, session.userId), eq(authSession.gymId, gymId))).returning({ id: authSession.id });
        if (!updated) throw new AppError('unauthenticated', 'Session expired');
        await writeAudit(tx, { gymId, actorKind: 'user', actorUserId: session.userId, action: 'portal.household_selected',
          targetType: 'household_user', targetId: login.id, occurredAt: clock.now() });
      });
    },
  };
}
export type PortalSessionStore = ReturnType<typeof createPortalSessionStore>;

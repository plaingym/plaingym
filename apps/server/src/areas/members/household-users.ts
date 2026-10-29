// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { forGym, householdUsers, households, members, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { createHouseholdUserRequestSchema, householdUserSchema, type CreateHouseholdUserRequest, type Pagination } from '@plaingym/shared/contracts';
import { clock as defaultClock } from '../../core/clock.js';
import { notFound, type MutationContext } from '../../core/interfaces/common.js';
import { createPortalInvitationStore } from '../../infra/auth/portal-invitations.js';
import { needsGuardian } from '../waivers/snapshot.js';

export async function assertPortalLoginTarget(tx: Transaction, householdId: string, memberId: string | null, scope: 'payer' | 'member', clock: Clock, timezone = 'UTC') {
  if (!(await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)).for('update'))[0]) notFound();
  if (memberId) {
    const [member] = await tx.select({ dateOfBirth: members.dateOfBirth }).from(members).where(and(eq(members.id, memberId), eq(members.householdId, householdId), isNull(members.anonymizedAt)));
    if (!member) notFound();
    if (scope === 'member' && needsGuardian(member.dateOfBirth, clock.now(), timezone)) throw new AppError('invalid_request', 'An adult date of birth is required for a member login');
  }
}

const record = (row: typeof householdUsers.$inferSelect) => householdUserSchema.parse({ id: row.id, householdId: row.householdId, userId: row.userId, scope: row.scope, memberId: row.memberId, createdAt: row.createdAt.toISOString() });
export function createHouseholdUsersService(options: { scope?: typeof forGym; clock?: Clock; loginEmails?: ReturnType<typeof createPortalInvitationStore>['loginEmails'] } = {}) {
  const scope = options.scope ?? forGym, clock = options.clock ?? defaultClock;
  const audit = (tx: Parameters<Parameters<typeof forGym>[1]>[0], context: MutationContext, action: string, id: string) => writeAudit(tx, {
    gymId: context.gymId, actorKind: context.actor.kind, ...(context.actor.kind === 'user' ? { actorUserId: context.actor.userId } : {}),
    action, targetType: 'household_user', targetId: id, occurredAt: clock.now(),
  });
  return {
    async list(gymId: string, householdId: string, query: Pagination) {
      return scope(gymId, async tx => {
        if (!(await tx.select({ id: households.id }).from(households).where(eq(households.id, householdId)))[0]) notFound();
        const where = eq(householdUsers.householdId, householdId);
        const total = await tx.$count(householdUsers, where);
        const rows = await tx.select().from(householdUsers).where(where).orderBy(asc(householdUsers.id)).limit(query.limit).offset(query.offset);
        return { data: rows.map(record), pagination: { ...query, total } };
      });
    },
    loginEmails: options.loginEmails ?? createPortalInvitationStore().loginEmails,
    async create(context: MutationContext & { timezone?: string }, householdId: string, raw: CreateHouseholdUserRequest) {
      const input = createHouseholdUserRequestSchema.parse(raw);
      return scope(context.gymId, async tx => {
        await assertPortalLoginTarget(tx, householdId, input.memberId ?? null, input.scope, clock, context.timezone);
        try {
          const [row] = await tx.insert(householdUsers).values({ gymId: context.gymId, householdId, userId: input.userId, scope: input.scope, memberId: input.memberId ?? null, createdAt: clock.now() }).onConflictDoNothing().returning();
          if (!row) throw new AppError('conflict', 'Portal login already linked');
          await audit(tx, context, 'household_user.created', row.id);
          return record(row);
        } catch (error) {
          const cause = error instanceof Error && 'cause' in error ? error.cause : error;
          if (cause && typeof cause === 'object' && 'code' in cause && cause.code === '23503') notFound();
          throw error;
        }
      });
    },
    async revoke(context: MutationContext, householdId: string, id: string) {
      return scope(context.gymId, async tx => {
        const [row] = await tx.delete(householdUsers).where(and(eq(householdUsers.id, id), eq(householdUsers.householdId, householdId))).returning();
        if (!row) notFound();
        await audit(tx, context, 'household_user.revoked', row.id);
      });
    },
  };
}
export type HouseholdUsersService = ReturnType<typeof createHouseholdUsersService>;

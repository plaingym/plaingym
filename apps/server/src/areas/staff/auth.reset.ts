// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import { staffRoles, householdUsers, type Transaction } from '@plaingym/db';
import { AppError, type Clock, type StaffRole } from '@plaingym/shared';
import { createAccountService, type AccountService } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';

const rank: Record<StaffRole, number> = { owner: 4, admin: 3, coach: 2, front_desk: 1 };
/** Re-read both staff and household links inside the reset transaction; never trust request role claims. */
export async function assertCanResetPassword(tx: Transaction, input: { gymId: string; actorUserId: string; targetUserId: string }) {
  const roles = await tx.select().from(staffRoles).where(inArray(staffRoles.userId, [input.actorUserId, input.targetUserId])).orderBy(staffRoles.userId).for('update');
  const actor = roles.find((row) => row.userId === input.actorUserId);
  const target = roles.find((row) => row.userId === input.targetUserId);
  const households = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, input.targetUserId)).for('update');
  if (!target && !households.length) throw new AppError('not_found', 'Account not found');
  if (!actor || !['owner', 'admin', 'front_desk'].includes(actor.role)) throw new AppError('forbidden', 'Password reset is not permitted');
  const actorRank = rank[actor.role as StaffRole] ?? 0;
  const targetRank = target ? rank[target.role as StaffRole] ?? 4 : 0;
  if (target?.role === 'owner' || targetRank >= actorRank || (actor.role === 'front_desk' && target)) throw new AppError('forbidden', 'Protected account');
}
export async function resetStaffPassword(input: { gymId: string; actorUserId: string; targetUserId: string; newPassword: string; clock: Clock }, accounts: AccountService = createAccountService(authConfig())) {
  await accounts.resetPassword({ ...input, userId: input.targetUserId, authorize: (tx) => assertCanResetPassword(tx, input) });
}
/** The local owner recovery path is limited to a current owner in this single gym. */
export async function assertOwnerRecovery(tx: Transaction, gymId: string, userId: string) {
  const [owner] = await tx.select({ id: staffRoles.id }).from(staffRoles).where(and(eq(staffRoles.gymId, gymId), eq(staffRoles.userId, userId), eq(staffRoles.role, 'owner'))).for('update');
  if (!owner) throw new AppError('not_found', 'Owner account not found');
}

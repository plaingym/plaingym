// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { authVerification, authUser, authAccount, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { z } from 'zod';
import { passwordAdapter } from './password.js';

/** The staff role an invitation was issued for; a changed or revoked role no longer matches. */
export const staffInvitationBindingSchema = z.strictObject({
  userId: z.uuid(), staffRoleId: z.uuid(), role: z.enum(['admin', 'coach', 'front_desk']), revision: z.int().positive(),
});
export type StaffInvitationBinding = z.infer<typeof staffInvitationBindingSchema>;
export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface AcceptInvitation {
  readonly gymId: string;
  readonly token: string;
  /** Required in password mode, refused otherwise. */
  readonly password?: string | undefined;
  readonly passwordMode: boolean;
  readonly clock: Clock;
}
/** Runs in the consuming transaction, after the invitation and its user are locked. Throw to reject. */
export type ConsumeInvitation = (tx: Transaction, binding: StaffInvitationBinding) => Promise<void>;
const lifetime = 7 * 24 * 60 * 60 * 1000;
const identifier = (gymId: string, token: string) => `staff-invitation:${gymId}:${createHash('sha256').update(token).digest('hex')}`;
const invalid = () => new AppError('not_found', 'Invitation is invalid or expired');

/** Invitation tokens live hashed in `auth_verification`, bound to the issuing gym and staff role. */
export function createInvitationStore(database = systemDatabase) {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  return {
    /** Runs in the caller's transaction. Replaces outstanding links for the binding and returns the raw token once. */
    async issue(tx: Transaction, gymId: string, binding: StaffInvitationBinding, clock: Clock) {
      const token = randomBytes(32).toString('hex'), value = JSON.stringify(staffInvitationBindingSchema.parse(binding));
      await tx.delete(authVerification).where(eq(authVerification.value, value));
      await tx.insert(authVerification).values({ identifier: identifier(gymId, token), value,
        expiresAt: new Date(clock.now().getTime() + lifetime), createdAt: clock.now(), updatedAt: clock.now() });
      return token;
    },
    async outstanding(tx: Transaction, binding: StaffInvitationBinding) {
      const rows = await tx.select({ id: authVerification.id }).from(authVerification).where(eq(authVerification.value, JSON.stringify(staffInvitationBindingSchema.parse(binding))));
      return rows.length > 0;
    },
    /** Consumption, the caller's writes and any new password commit together; hashing happens before the transaction. */
    async accept(input: AcceptInvitation, consume: ConsumeInvitation) {
      assertNoTransaction('auth.acceptInvitation');
      if (!invitationTokenSchema.safeParse(input.token).success) throw invalid();
      const key = identifier(input.gymId, input.token);
      const [snapshot] = await database().select().from(authVerification).where(eq(authVerification.identifier, key));
      if (!snapshot || snapshot.expiresAt <= input.clock.now()) throw invalid();
      const binding = staffInvitationBindingSchema.parse(JSON.parse(snapshot.value));
      if (input.passwordMode && !input.password) throw new AppError('invalid_request', 'Password required');
      if (!input.passwordMode && input.password !== undefined) throw new AppError('forbidden', 'Password login is disabled');
      const [credential] = await database().select().from(authAccount).where(and(eq(authAccount.userId, binding.userId), eq(authAccount.providerId, 'credential')));
      // An invite never replaces an existing password. Existing password users prove their credentials.
      if (input.passwordMode && credential?.password && !await passwordAdapter.verify({ hash: credential.password, password: input.password! }))
        throw new AppError('forbidden', 'Existing account requires its current password');
      const hash = input.passwordMode && !credential?.password ? await passwordAdapter.hash(input.password!) : undefined;
      await forGym(input.gymId, async (tx) => {
        const [invite] = await tx.select().from(authVerification).where(eq(authVerification.id, snapshot.id)).for('update');
        if (!invite || invite.expiresAt <= input.clock.now() || invite.value !== snapshot.value) throw invalid();
        const [user] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, binding.userId)).for('update');
        if (!user) throw invalid();
        await consume(tx, binding);
        if (input.passwordMode) {
          const [current] = await tx.select().from(authAccount).where(and(eq(authAccount.userId, user.id), eq(authAccount.providerId, 'credential'))).for('update');
          if (current?.password !== credential?.password) throw new AppError('conflict', 'Account credentials changed');
          if (hash) {
            if (current) await tx.update(authAccount).set({ password: hash, updatedAt: input.clock.now() }).where(eq(authAccount.id, current.id));
            else await tx.insert(authAccount).values({ userId: user.id, accountId: user.id, providerId: 'credential', password: hash, createdAt: input.clock.now(), updatedAt: input.clock.now() });
          }
        }
        await tx.delete(authVerification).where(eq(authVerification.id, invite.id));
      });
    },
  };
}
export type InvitationStore = ReturnType<typeof createInvitationStore>;

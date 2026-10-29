// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { authVerification, authUser, authAccount, householdUsers, type Transaction } from '@plaingym/db';
import { scopedDatabase, systemDatabase } from '@plaingym/db/client';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { z } from 'zod';
import { passwordAdapter } from './password.js';

/** The household login an invitation was issued for; a changed or revoked role no longer matches. */
export const portalInvitationBindingSchema = z.strictObject({
  userId: z.uuid(), householdUserId: z.uuid(), householdId: z.uuid(), scope: z.enum(['payer', 'member']), memberId: z.uuid().nullable(),
});
export type PortalInvitationBinding = z.infer<typeof portalInvitationBindingSchema>;
export const invitationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface AcceptPortalInvitation {
  readonly gymId: string;
  readonly token: string;
  /** Required in password mode, refused otherwise. */
  readonly password?: string | undefined;
  readonly passwordMode: boolean;
  readonly clock: Clock;
}
/** Runs in the consuming transaction, after the invitation and its user are locked. Throw to reject. */
export type ConsumePortalInvitation = (tx: Transaction, binding: PortalInvitationBinding) => Promise<void>;
const lifetime = 7 * 24 * 60 * 60 * 1000;
const identifier = (gymId: string, token: string) => `portal-invitation:${gymId}:${createHash('sha256').update(token).digest('hex')}`;
const invalid = () => new AppError('not_found', 'Invitation is invalid or expired');

/** Invitation tokens live hashed in `auth_verification`, bound to the issuing gym and household login. */
export function createPortalInvitationStore(database = systemDatabase) {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  return {
    /** A staff-authorized household listing may display the linked identity's email. */
    async loginEmails(gymId: string, householdId: string) {
      return forGym(gymId, tx => tx.select({ id: householdUsers.id, email: authUser.email }).from(householdUsers)
        .innerJoin(authUser, eq(authUser.id, householdUsers.userId)).where(eq(householdUsers.householdId, householdId)));
    },
    /** Runs in the caller's transaction. Replaces outstanding links for the binding and returns the raw token once. */
    async issue(tx: Transaction, gymId: string, binding: PortalInvitationBinding, clock: Clock) {
      const token = randomBytes(32).toString('hex'), value = JSON.stringify(portalInvitationBindingSchema.parse(binding));
      await tx.delete(authVerification).where(eq(authVerification.value, value));
      await tx.insert(authVerification).values({ identifier: identifier(gymId, token), value,
        expiresAt: new Date(clock.now().getTime() + lifetime), createdAt: clock.now(), updatedAt: clock.now() });
      return token;
    },
    async outstanding(tx: Transaction, binding: PortalInvitationBinding) {
      const rows = await tx.select({ id: authVerification.id }).from(authVerification).where(eq(authVerification.value, JSON.stringify(portalInvitationBindingSchema.parse(binding))));
      return rows.length > 0;
    },
    /** Consumption, the caller's writes and any new password commit together; hashing happens before the transaction. */
    async accept(input: AcceptPortalInvitation, consume: ConsumePortalInvitation) {
      assertNoTransaction('auth.acceptInvitation');
      if (!invitationTokenSchema.safeParse(input.token).success) throw invalid();
      const key = identifier(input.gymId, input.token);
      const [snapshot] = await database().select().from(authVerification).where(eq(authVerification.identifier, key));
      if (!snapshot || snapshot.expiresAt <= input.clock.now()) throw invalid();
      const binding = portalInvitationBindingSchema.parse(JSON.parse(snapshot.value));
      if (input.passwordMode && !input.password) throw new AppError('invalid_request', 'Password required');
      if (input.password !== undefined && (input.password.length < 12 || input.password.length > 128)) throw new AppError('invalid_request', 'Password must contain 12 to 128 characters');
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
export type PortalInvitationStore = ReturnType<typeof createPortalInvitationStore>;


// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { authUser, authSession, authAccount, writeAudit, uuidv7, type Transaction } from '@plaingym/db';
import { systemDatabase, scopedDatabase } from '@plaingym/db/client';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { passwordAdapter } from './password.js';
import type { AuthConfig } from './config.js';

export interface PasswordReset {
  readonly gymId: string;
  readonly userId: string;
  readonly newPassword: string;
  readonly actorUserId?: string;
  readonly clock: Clock;
  /** Runs inside the same transaction as the password, revocations and audit. */
  authorize(tx: Transaction): Promise<void>;
}
export function createAccountService(config: AuthConfig, database = systemDatabase) {
  const forGym = <T>(gymId: string, fn: (tx: Transaction) => Promise<T>) => scopedDatabase(database()).forGym(gymId, fn);
  return {
    async findUserByEmail(email: string) {
      assertNoTransaction('auth.findUserByEmail');
      const [user] = await database().select({ id: authUser.id }).from(authUser).where(eq(authUser.email, email.trim().toLowerCase()));
      return user ?? null;
    },
    async provisionUser(gymId: string, email: string, name: string, clock: Clock) {
      return forGym(gymId, async (tx) => {
        const normalized = email.trim().toLowerCase();
        const [created] = await tx.insert(authUser).values({ email: normalized, name, createdAt: clock.now(), updatedAt: clock.now() }).onConflictDoNothing({ target: authUser.email }).returning({ id: authUser.id });
        const user = created ?? (await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.email, normalized)))[0];
        if (!user) throw new AppError('unavailable', 'Account provisioning failed');
        if (created) await writeAudit(tx, { gymId, actorKind: 'system', action: 'auth.user_created', targetType: 'user', targetId: user.id, occurredAt: clock.now() });
        return user;
      });
    },
    async createPasswordUser(gymId: string, email: string, name: string, password: string, clock: Clock) {
      if (!config.passwordEnabled || config.tenancy !== 'single') throw new AppError('forbidden', 'Password login is disabled');
      if (password.length < 12 || password.length > 128) throw new AppError('invalid_request', 'Password must contain 12 to 128 characters');
      const hash = await passwordAdapter.hash(password);
      return forGym(gymId, async (tx) => {
        const id = uuidv7();
        await tx.insert(authUser).values({ id, email: email.trim().toLowerCase(), name, createdAt: clock.now(), updatedAt: clock.now() });
        await tx.insert(authAccount).values({ userId: id, accountId: id, providerId: 'credential', password: hash, createdAt: clock.now(), updatedAt: clock.now() });
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'auth.user_created', targetType: 'user', targetId: id, occurredAt: clock.now() });
        return { userId: id };
      });
    },
    async resetPassword(input: PasswordReset) {
      assertNoTransaction('auth.resetPassword');
      if (!config.passwordEnabled || config.tenancy !== 'single') throw new AppError('forbidden', 'Password reset is disabled');
      if (input.newPassword.length < 12 || input.newPassword.length > 128) throw new AppError('invalid_request', 'Password must contain 12 to 128 characters');
      const hash = await passwordAdapter.hash(input.newPassword);
      await forGym(input.gymId, async (tx) => {
        // Lock identity first so concurrent resets serialize. Business authorization is reloaded below.
        const [user] = await tx.select({ id: authUser.id }).from(authUser).where(eq(authUser.id, input.userId)).for('update');
        if (!user) throw new AppError('not_found', 'Account not found');
        await input.authorize(tx);
        await tx.insert(authAccount).values({ userId: user.id, accountId: user.id, providerId: 'credential', password: hash, createdAt: input.clock.now(), updatedAt: input.clock.now() })
          .onConflictDoUpdate({ target: [authAccount.providerId, authAccount.accountId], set: { password: hash, updatedAt: input.clock.now() } });
        await tx.delete(authSession).where(eq(authSession.userId, user.id));
        await writeAudit(tx, { gymId: input.gymId, actorKind: input.actorUserId ? 'user' : 'system', actorUserId: input.actorUserId,
          action: 'auth.password_reset', targetType: 'user', targetId: user.id, occurredAt: input.clock.now() });
      });
    },
    async revokeAllSessions(gymId: string, userId: string, clock: Clock) {
      await forGym(gymId, async (tx) => {
        await tx.delete(authSession).where(eq(authSession.userId, userId));
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'auth.sessions_revoked', targetType: 'user', targetId: userId, occurredAt: clock.now() });
      });
    },
    async hasPassword(userId: string) {
      const [account] = await database().select({ id: authAccount.id }).from(authAccount).where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')));
      return Boolean(account);
    },
  };
}
export type AccountService = ReturnType<typeof createAccountService>;

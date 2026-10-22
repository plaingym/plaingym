// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { staffRoles, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as defaultClock } from '../../core/clock.js';
import { createAccountService, type AccountService, type ProvisionAccount } from '../../infra/auth/accounts.js';
import { authConfig } from '../../infra/auth/config.js';
import { createAuthService } from '../../infra/auth/service.js';
import { createAuthEmailSender } from '../../infra/auth/delivery.js';

export interface OwnerBootstrap {
  gymId: string;
  email: string;
  name: string;
  origin: string;
  /** Setup may create a password owner when email delivery is unavailable. */
  password?: string;
}
export interface OwnerBootstrapResult { userId: string; delivery: 'email' | 'password'; }
export type ProvisionOwner = (input: OwnerBootstrap) => Promise<OwnerBootstrapResult>;

/** Shared by gym creation and setup. A delivery failure leaves a retryable owner. */
export function createOwnerService(options: {
  accounts: Pick<AccountService, 'provisionUser' | 'createPasswordUser'>;
  sendMagicLink(input: OwnerBootstrap): Promise<void>;
  clock?: Clock;
}): ProvisionOwner {
  const clock = options.clock ?? defaultClock;
  return async (input) => {
    assertNoTransaction('auth.provisionOwner');
    const email = input.email.trim().toLowerCase();
    const grant: ProvisionAccount = async (tx, userId) => {
      const [created] = await tx.insert(staffRoles).values({ gymId: input.gymId, userId, role: 'owner', createdAt: clock.now() })
        .onConflictDoNothing({ target: [staffRoles.gymId, staffRoles.userId] }).returning({ id: staffRoles.id });
      if (!created) {
        const [existing] = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, userId));
        if (existing?.role !== 'owner') throw new AppError('conflict', 'Account already has a different staff role');
      } else await writeAudit(tx, { gymId: input.gymId, actorKind: 'system', action: 'auth.owner_provisioned', targetType: 'user', targetId: userId, occurredAt: clock.now() });
    };
    if (input.password !== undefined) {
      const user = await options.accounts.createPasswordUser(input.gymId, email, input.name, input.password, clock, grant);
      return { userId: user.userId, delivery: 'password' };
    }
    const user = await options.accounts.provisionUser(input.gymId, email, input.name, clock, grant);
    await options.sendMagicLink({ ...input, email });
    return { userId: user.id, delivery: 'email' };
  };
}

export function createDefaultOwnerService(): ProvisionOwner {
  const config = authConfig();
  const auth = createAuthService({ config, ...(config.smtpConfigured ? { sendMagicLink: createAuthEmailSender() } : {}) });
  return createOwnerService({ accounts: createAccountService(config), async sendMagicLink(input) {
    if (!config.smtpConfigured) throw new AppError('unavailable', 'Owner email delivery requires SMTP');
    await auth.bind({ gymId: input.gymId, origin: input.origin, clientIp: '127.0.0.1' }).sendLoginLink(input.email);
  } });
}

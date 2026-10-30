// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { forGym, staffRoles, households, members, householdUsers, uuidv7, writeAudit } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { createAccountService } from '../infra/auth/accounts.js';
import type { AuthConfig } from '../infra/auth/config.js';
import { createAuthService } from '../infra/auth/service.js';
import type { DemoRole } from '@plaingym/shared/contracts';
import { requireDemo, type DemoConfig } from './config.js';

export const demoEmail = (gymId: string, role: DemoRole) => `${role}.${gymId}@example.invalid`;
/** The one-click student's household and member; the portal seed finds them by these names. */
export const demoStudent = { household: 'Demo student', firstName: 'Alex', lastName: 'Student' } as const;
/** One-click logins per client address; the login route enforces it, and the internal sign-in uses the same rule. */
export const demoLoginRateLimit = { window: 60, max: 20 } as const;
export function createDemoIdentities(options: {
  config: DemoConfig; authConfig: AuthConfig; clock: Clock;
  accounts?: Pick<ReturnType<typeof createAccountService>, 'provisionUser' | 'findUserByEmail'>;
  scope?: typeof forGym; authFactory?: typeof createAuthService;
}) {
  const scope = options.scope ?? forGym;
  const accounts = options.accounts ?? createAccountService(options.authConfig);
  return { async seed(gymId: string) {
    requireDemo(options.config);
    for (const role of ['owner', 'coach', 'student'] as const) {
      await accounts.provisionUser(gymId, demoEmail(gymId, role), role, options.clock, async (tx, userId) => {
        if (role !== 'student') await tx.insert(staffRoles).values({ gymId, userId, role, createdAt: options.clock.now() })
          .onConflictDoNothing({ target: [staffRoles.gymId, staffRoles.userId] });
        else {
          const [existing] = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, userId));
          if (!existing) {
            const householdId = uuidv7(), memberId = uuidv7();
            await tx.insert(households).values({ id: householdId, gymId, name: demoStudent.household, email: demoEmail(gymId, role), createdAt: options.clock.now() });
            await tx.insert(members).values({ id: memberId, gymId, householdId, firstName: demoStudent.firstName, lastName: demoStudent.lastName, status: 'active', createdAt: options.clock.now() });
            await tx.insert(householdUsers).values({ gymId, userId, householdId, memberId, scope: 'payer', createdAt: options.clock.now() });
          }
        }
        await writeAudit(tx, { gymId, actorKind: 'system', action: 'demo.identity_seeded', targetType: 'user', targetId: userId, occurredAt: options.clock.now() });
      });
    }
  }, async login(gymId: string, role: DemoRole, origin: string, clientIp: string): Promise<Response> {
    requireDemo(options.config);
    const user = await accounts.findUserByEmail(demoEmail(gymId, role));
    if (!user) throw new AppError('not_found', 'Not found');
    const permitted = await scope(gymId, async (tx) => {
      if (role === 'student') return (await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, user.id))).length > 0;
      return (await tx.select({ id: staffRoles.id }).from(staffRoles).where(and(eq(staffRoles.userId, user.id), eq(staffRoles.role, role)))).length > 0;
    });
    if (!permitted) throw new AppError('not_found', 'Not found');
    // A new auth binding captures only this request's link; no transport or shared token buffer.
    let link: string | undefined;
    // The sign-in limiter restarts its window on every request, so its stricter default would refuse
    // one-click logins that the login route already allows.
    const auth = (options.authFactory ?? createAuthService)({ config: options.authConfig, rateLimit: demoLoginRateLimit,
      sendMagicLink: async (input) => { link = input.url; } })
      .bind({ gymId, origin, clientIp, smtpConfigured: true });
    await auth.sendLoginLink(demoEmail(gymId, role));
    if (!link) throw new AppError('unavailable', 'Demo login unavailable');
    const verified = await auth.handler(new Request(link));
    if (!verified.headers.has('set-cookie')) throw new AppError('unavailable', 'Demo login unavailable');
    const headers = new Headers({ 'cache-control': 'no-store', location: role === 'student' ? '/portal' : '/admin' });
    for (const cookie of verified.headers.getSetCookie()) headers.append('set-cookie', cookie);
    return new Response(null, { status: 303, headers });
  } };
}

// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, exists, notExists } from 'drizzle-orm';
import { forGym, staffRoles, households, members, householdUsers, auditEvents, uuidv7, writeAudit, type Transaction } from '@plaingym/db';
import { AppError, type Clock } from '@plaingym/shared';
import { createAccountService } from '../infra/auth/accounts.js';
import type { AuthConfig } from '../infra/auth/config.js';
import { createAuthService } from '../infra/auth/service.js';
import { demoJoinedMemberLimit, type DemoLoginTarget, type DemoRole } from '@plaingym/shared/contracts';
import { requireDemo, type DemoConfig } from './config.js';

export const demoEmail = (gymId: string, role: DemoRole) => `${role}.${gymId}@example.invalid`;
/** The one-click student's household and member; the portal seed finds them by these names. */
export const demoStudent = { household: 'Demo student', firstName: 'Alex', lastName: 'Student' } as const;
/** The name each one-click login is known by: the staff logins have no staff profile, so the shell shows this name. */
export const demoLoginNames: Record<DemoRole, string> = { owner: 'Sam Owner', coach: 'Jordan Coach', student: `${demoStudent.firstName} ${demoStudent.lastName}` };
/** One-click logins per client address; the login route enforces it, and the internal sign-in uses the same rule. */
export const demoLoginRateLimit = { window: 60, max: 20 } as const;

/** Payer logins of households that joined through `/join` (their admission is audited), never a staff identity's. */
function joinedLogins(tx: Transaction) {
  return tx.select({ id: householdUsers.id, userId: householdUsers.userId, name: households.name, email: households.email })
    .from(householdUsers).innerJoin(households, and(eq(households.gymId, householdUsers.gymId), eq(households.id, householdUsers.householdId)))
    .where(and(eq(householdUsers.scope, 'payer'),
      exists(tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.gymId, households.gymId),
        eq(auditEvents.action, 'public.join.admitted'), eq(auditEvents.targetId, households.id)))),
      notExists(tx.select({ id: staffRoles.id }).from(staffRoles).where(eq(staffRoles.userId, householdUsers.userId)))))
    .orderBy(desc(households.createdAt), desc(householdUsers.id)).limit(demoJoinedMemberLimit);
}
/** The sandbox's joined members the demo menu offers by name, latest join first. The `id` is their payer login's. */
export async function joinedMembers(gymId: string, scope: typeof forGym = forGym) {
  return (await scope(gymId, (tx) => joinedLogins(tx))).map(({ id, name }) => ({ id, name }));
}

export function createDemoIdentities(options: {
  config: DemoConfig; authConfig: AuthConfig; clock: Clock;
  accounts?: Pick<ReturnType<typeof createAccountService>, 'provisionUser' | 'findUserByEmail'>;
  scope?: typeof forGym; authFactory?: typeof createAuthService;
}) {
  const scope = options.scope ?? forGym;
  const accounts = options.accounts ?? createAccountService(options.authConfig);
  /** The login's address and user, if it is one of the sandbox's own seeded roles or offered joined members; otherwise 404. */
  async function identity(gymId: string, target: DemoLoginTarget): Promise<{ email: string; userId: string }> {
    if ('role' in target) {
      const { role } = target, email = demoEmail(gymId, role), user = await accounts.findUserByEmail(email);
      if (!user) throw new AppError('not_found', 'Not found');
      const permitted = await scope(gymId, async (tx) => {
        if (role === 'student') return (await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, user.id))).length > 0;
        return (await tx.select({ id: staffRoles.id }).from(staffRoles).where(and(eq(staffRoles.userId, user.id), eq(staffRoles.role, role)))).length > 0;
      });
      if (!permitted) throw new AppError('not_found', 'Not found');
      return { email, userId: user.id };
    }
    // Only a login the menu offers: row-level security keeps another sandbox's logins out of this query.
    const login = (await scope(gymId, (tx) => joinedLogins(tx))).find((row) => row.id === target.member);
    if (!login?.email) throw new AppError('not_found', 'Not found');
    // The household's address must still name this login's own account; a changed address signs in nobody.
    const user = await accounts.findUserByEmail(login.email);
    if (!user || user.id !== login.userId) throw new AppError('not_found', 'Not found');
    return { email: login.email, userId: user.id };
  }
  return { async seed(gymId: string) {
    requireDemo(options.config);
    for (const role of ['owner', 'coach', 'student'] as const) {
      await accounts.provisionUser(gymId, demoEmail(gymId, role), demoLoginNames[role], options.clock, async (tx, userId) => {
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
  }, async login(gymId: string, target: DemoLoginTarget, origin: string, clientIp: string): Promise<Response> {
    requireDemo(options.config);
    const { email } = await identity(gymId, target);
    // A new auth binding captures only this request's link; no transport or shared token buffer.
    let link: string | undefined;
    // The sign-in limiter restarts its window on every request, so its stricter default would refuse
    // one-click logins that the login route already allows.
    const auth = (options.authFactory ?? createAuthService)({ config: options.authConfig, rateLimit: demoLoginRateLimit,
      sendMagicLink: async (input) => { link = input.url; } })
      .bind({ gymId, origin, clientIp, smtpConfigured: true });
    await auth.sendLoginLink(email);
    if (!link) throw new AppError('unavailable', 'Demo login unavailable');
    const verified = await auth.handler(new Request(link));
    if (!verified.headers.has('set-cookie')) throw new AppError('unavailable', 'Demo login unavailable');
    const headers = new Headers({ 'cache-control': 'no-store', location: demoLoginRedirect(target) });
    for (const cookie of verified.headers.getSetCookie()) headers.append('set-cookie', cookie);
    return new Response(null, { status: 303, headers });
  } };
}
/** Staff roles open the admin; the student and joined members open their portal. */
export const demoLoginRedirect = (target: DemoLoginTarget) => 'role' in target && target.role !== 'student' ? '/admin' as const : '/portal' as const;

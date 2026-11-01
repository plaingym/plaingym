// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq } from 'drizzle-orm';
import { forGym, householdUsers, members, staffProfiles, staffRoles } from '@plaingym/db';
import { AppError, staffRoles as validRoles } from '@plaingym/shared';
import { shellContracts, type ShellBootstrap } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { authConfig } from '../../infra/auth/config.js';
import { requestSession } from '../../infra/auth/middleware.js';
import { createSettingsService } from '../settings/settings.js';

type LoginMethods = (gymId: string) => ShellBootstrap['login'] | Promise<ShellBootstrap['login']>;
let configuredLogin: LoginMethods | undefined;
/** Runtime wiring supplies each gym's login methods; without it, the install's settings apply. */
export function configureLoginMethods(login: LoginMethods): void { configuredLogin = login; }
function installLogin(): ShellBootstrap['login'] {
  const config = authConfig();
  return { password: config.passwordEnabled, magicLink: config.smtpConfigured };
}

export function createAuthBootstrapRoutes(options: {
  scope?: typeof forGym;
  settings?: Pick<ReturnType<typeof createSettingsService>, 'get'>;
  login?: LoginMethods;
} = {}) {
  const scope = options.scope ?? forGym;
  const settings = options.settings ?? createSettingsService();
  const contract = shellContracts.bootstrap;
  return [route({
    method: contract.method, path: contract.path, permission: contract.permission,
    responses: { 200: { description: 'Current gym and login', content: { 'application/json': { schema: contract.response } } } },
  }, async (context) => {
    const { gym, principal } = context.get('context');
    const details = await settings.get(gym.gymId);
    let session: ShellBootstrap['session'] = null;
    if (principal.kind === 'staff' || principal.kind === 'member') {
      const principalGym = principal.kind === 'staff' ? principal.gymId : principal.scope.gymId;
      if (principalGym !== gym.gymId) throw new AppError('forbidden', 'Authentication gym mismatch');
      const loginName = requestSession(context.req.raw)?.userName;
      session = await scope(gym.gymId, async (tx) => {
        const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, principal.userId));
        const links = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, principal.userId)).limit(1);
        // This gym's own records come first, so a login in two gyms is known by each gym's name for it.
        const [profile] = await tx.select({ name: staffProfiles.displayName }).from(staffProfiles).where(eq(staffProfiles.userId, principal.userId)).limit(1);
        // A payer link with no member (the payer is not a person on the roster) has no name here and falls back to the login's own.
        const portal = principal.kind === 'member' ? principal.scope : undefined;
        const [linked] = profile ? [] : await tx.select({ firstName: members.firstName, lastName: members.lastName }).from(householdUsers)
          .innerJoin(members, and(eq(members.gymId, householdUsers.gymId), eq(members.id, householdUsers.memberId)))
          .where(and(eq(householdUsers.userId, principal.userId), portal ? eq(householdUsers.householdId, portal.householdId) : undefined,
            portal?.memberId ? eq(householdUsers.memberId, portal.memberId) : undefined))
          .orderBy(asc(householdUsers.createdAt), asc(householdUsers.id)).limit(1);
        const displayName = [profile?.name, linked && `${linked.firstName} ${linked.lastName}`, loginName].map(value => value?.trim()).find(Boolean) ?? principal.userId;
        return { userId: principal.userId, displayName, roles: roles.flatMap(({ role }) => validRoles.filter((value) => value === role)), member: links.length > 0 };
      });
    }
    const login = await (options.login ?? configuredLogin ?? installLogin)(gym.gymId);
    context.header('Cache-Control', 'no-store');
    context.header('Vary', 'Cookie');
    return context.json({ data: { gym: { id: gym.gymId, name: details.name, timezone: gym.timezone, currency: details.currency, enabledModules: [...gym.enabledModules].sort() }, session, login } }, 200);
  })];
}

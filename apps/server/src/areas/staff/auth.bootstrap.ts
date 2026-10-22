// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, householdUsers, staffRoles } from '@plaingym/db';
import { AppError, staffRoles as validRoles } from '@plaingym/shared';
import { shellContracts, type ShellBootstrap } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { authConfig } from '../../infra/auth/config.js';
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
      session = await scope(gym.gymId, async (tx) => {
        const roles = await tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, principal.userId));
        const links = await tx.select({ id: householdUsers.id }).from(householdUsers).where(eq(householdUsers.userId, principal.userId)).limit(1);
        return { userId: principal.userId, roles: roles.flatMap(({ role }) => validRoles.filter((value) => value === role)), member: links.length > 0 };
      });
    }
    const login = await (options.login ?? configuredLogin ?? installLogin)(gym.gymId);
    context.header('Cache-Control', 'no-store');
    context.header('Vary', 'Cookie');
    return context.json({ data: { gym: { id: gym.gymId, name: details.name, enabledModules: [...gym.enabledModules].sort() }, session, login } }, 200);
  })];
}

// SPDX-License-Identifier: AGPL-3.0-only
import { staffContracts } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import { route } from '../../core/registry.js';
import { resetStaffPassword } from './auth.reset.js';
import { createAuthBootstrapRoutes } from './auth.bootstrap.js';
import type { AccountService } from '../../infra/auth/accounts.js';
import { passwordLogin, type AuthConfig } from '../../infra/auth/config.js';

interface StaffAuthOptions {
  accounts: AccountService;
  config: AuthConfig;
  smtpConfigured(gymId: string): Promise<boolean>;
}
let configured: StaffAuthOptions | undefined;
export function configureStaffAuth(options: StaffAuthOptions) { configured = options; }

const contract = staffContracts.resetPassword;
export function createStaffAuthRoutes(options?: StaffAuthOptions) {
  return [...createAuthBootstrapRoutes(), route({
  method: contract.method, path: contract.path, permission: contract.permission,
  request: { params: contract.params, body: { required: true, content: { 'application/json': { schema: contract.body } } } },
  responses: { 200: { description: 'Password reset', content: { 'application/json': { schema: contract.response } } } },
}, async (context) => {
  const { principal, gym, clock } = context.get('context');
  if (principal.kind !== 'staff') throw new AppError('unauthenticated', 'Staff login required');
  const dependencies = options ?? configured;
  if (!dependencies) throw new AppError('unavailable', 'Staff authentication is not configured');
  if (dependencies.config.tenancy !== 'single' || !passwordLogin(dependencies.config, await dependencies.smtpConfigured(gym.gymId)))
    throw new AppError('forbidden', 'Password login is off for this gym');
  await resetStaffPassword({ gymId: gym.gymId, actorUserId: principal.userId, targetUserId: context.req.valid('param').userId, newPassword: context.req.valid('json').newPassword, clock }, dependencies.accounts);
  return context.json({ data: null }, 200);
  })];
}
export const routes = createStaffAuthRoutes();

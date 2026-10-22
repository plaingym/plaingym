// SPDX-License-Identifier: AGPL-3.0-only
import { staffContracts } from '@plaingym/shared/contracts';
import { AppError } from '@plaingym/shared';
import { route } from '../../core/registry.js';
import { resetStaffPassword } from './auth.reset.js';

const contract = staffContracts.resetPassword;
export const routes = [route({
  method: contract.method, path: contract.path, permission: contract.permission,
  request: { params: contract.params, body: { required: true, content: { 'application/json': { schema: contract.body } } } },
  responses: { 200: { description: 'Password reset', content: { 'application/json': { schema: contract.response } } } },
}, async (context) => {
  const { principal, gym, clock } = context.get('context');
  if (principal.kind !== 'staff') throw new AppError('unauthenticated', 'Staff login required');
  await resetStaffPassword({ gymId: gym.gymId, actorUserId: principal.userId, targetUserId: context.req.valid('param').userId, newPassword: context.req.valid('json').newPassword, clock });
  return context.json({ data: null }, 200);
})];

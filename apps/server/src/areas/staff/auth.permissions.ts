// SPDX-License-Identifier: AGPL-3.0-only
import { canMember, canStaff, errorResponse, AppError } from '@plaingym/shared';
import type { PermissionMiddleware } from '../../core/registry.js';

export const authorize: PermissionMiddleware = (permission) => async (context, next) => {
  const { principal, gym, requestId } = context.get('context');
  let allowed = permission.kind === 'public';
  switch (permission.kind) {
    case 'public': break;
    case 'staff': allowed = principal.kind === 'staff' && principal.gymId === gym.gymId && canStaff(principal.roles, permission.capability); break;
    case 'member': allowed = principal.kind === 'member' && principal.scope.gymId === gym.gymId && canMember(principal.scope.role, permission.capability); break;
    case 'kiosk': allowed = principal.kind === 'kiosk' && principal.gymId === gym.gymId; break;
    case 'signed_link': allowed = principal.kind === 'signed_link' && principal.gymId === gym.gymId && principal.link.purpose === permission.purpose; break;
  }
  if (!allowed) {
    const error = new AppError(principal.kind === 'anonymous' ? 'unauthenticated' : 'forbidden', 'Access denied');
    return context.json(errorResponse(error, requestId), error.status);
  }
  await next();
};

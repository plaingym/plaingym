// SPDX-License-Identifier: AGPL-3.0-only
import { bodyLimit } from 'hono/body-limit';
import { AppError } from '@plaingym/shared';
import type { RequestContext } from '../../core/context.js';

export function leadStaff(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', 'Lead not found');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export const leadBodyLimit = (maxSize: number) => bodyLimit({ maxSize,
  onError: () => { throw new AppError('invalid_request', 'Request too large'); } });

// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, staffRoles } from '@plaingym/db';
import { AppError, staffRoles as validRoles } from '@plaingym/shared';
import type { Context, MiddlewareHandler } from 'hono';
import type { RequestEnvironment, Principal } from '../../core/context.js';
import type { AuthService, ResolvedAuthGym } from './service.js';
import { shellContracts } from '@plaingym/shared/contracts';

export function sessionMiddleware(options: {
  auth: AuthService;
  resolve(context: Context<RequestEnvironment>): ResolvedAuthGym;
  /** A member surface may supply its household-scoped principal loader. */
  principal?: (userId: string, context: Context<RequestEnvironment>) => Promise<Principal>;
  /** Per-gym email availability, consulted only for login endpoints (password `auto` and magic links). */
  smtpConfigured?: (gymId: string) => Promise<boolean>;
}): MiddlewareHandler<RequestEnvironment> {
  return async (context, next) => {
    const current = context.get('context');
    if (!current?.gym) throw new AppError('not_found', 'Gym not found');
    const resolved = options.resolve(context);
    if (resolved.gymId !== current.gym.gymId) throw new AppError('forbidden', 'Authentication gym mismatch');
    const authPath = context.req.path !== shellContracts.bootstrap.path
      && (context.req.path === '/api/auth' || context.req.path.startsWith('/api/auth/'));
    if (authPath) {
      const smtpConfigured = options.smtpConfigured ? await options.smtpConfigured(resolved.gymId) : resolved.smtpConfigured;
      return options.auth.bind({ ...resolved, ...(smtpConfigured === undefined ? {} : { smtpConfigured }) }).handler(context.req.raw);
    }
    const auth = options.auth.bind(resolved);
    let session;
    try { session = await auth.checkedSession(context.req.raw); }
    catch (error) {
      if (error instanceof Error && error.message === 'session_gym_mismatch') return context.json({ error: 'session_gym_mismatch' }, 403);
      throw error;
    }
    let principal: Principal = { kind: 'anonymous' };
    if (session) {
      if (options.principal) principal = await options.principal(session.userId, context);
      else {
        const roles = await forGym(resolved.gymId, (tx) => tx.select({ role: staffRoles.role }).from(staffRoles).where(eq(staffRoles.userId, session.userId)));
        principal = { kind: 'staff', gymId: resolved.gymId, userId: session.userId, roles: roles.flatMap(({ role }) => validRoles.filter((value) => value === role)) };
      }
    }
    context.set('context', { ...current, principal });
    await next();
  };
}

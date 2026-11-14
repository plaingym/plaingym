// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { forGym, gyms } from '@plaingym/db';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import type { RequestEnvironment } from '../core/context.js';
import type { DemoPool } from './pool.js';
import { sandboxSettings } from './config.js';

export const showcaseReason = 'demo_showcase_read_only';
const authentication = new Set(['/api/demo/login', '/api/demo/sign-in-link', '/api/auth/sign-in/magic-link', '/api/auth/sign-in/email', '/api/auth/sign-out']);
/** Mount after tenant resolution and before session handling or any tenant route. */
export function demoRequestGuard(pool: DemoPool, scope: typeof forGym = forGym): MiddlewareHandler<RequestEnvironment> {
  return async (c, next) => {
    const gymId = c.get('context').gym.gymId;
    const [gym] = await scope(gymId, tx => tx.select().from(gyms).where(eq(gyms.id, gymId)));
    const demo = sandboxSettings(gym?.settings);
    if (demo) {
      if (!demo.ready || ['pool', 'queued', 'retired'].includes(demo.kind ?? '') || Date.parse(demo.expiresAt) <= c.get('context').clock.now().getTime())
        throw new AppError('not_found', 'Not found');
      const read = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
      const link = /^\/(?:l(?:\/|$)|api\/links(?:\/|$))/.test(c.req.path);
      if (demo.kind === 'showcase' && (link || (!read && !authentication.has(c.req.path))))
        throw new AppError('forbidden', 'This demo is shared. Make your own copy to change things.', { reason: [showcaseReason] });
      await pool.touch(gymId);
    }
    await next();
  };
}

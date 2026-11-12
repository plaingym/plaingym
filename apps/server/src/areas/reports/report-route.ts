// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import type { EndpointContract } from '@plaingym/shared/contracts';
import type { MiddlewareHandler } from 'hono';
import type { z } from 'zod';
import type { RequestEnvironment } from '../../core/context.js';
import { route } from '../../core/registry.js';
import type { ReportContext } from './range.js';

/** Shared staff scope and response policy for the three report endpoints. */
export function reportRoute<Q extends z.ZodObject>(
  contract: EndpointContract & { method: 'get'; query: Q }, description: string,
  service: { get(context: ReportContext, query: z.output<Q>): Promise<{ data: unknown }> },
  middleware?: MiddlewareHandler<RequestEnvironment>,
) {
  return route({ ...contract, ...(middleware ? { middleware } : {}), request: { query: contract.query },
    responses: { 200: { description, content: { 'application/json': { schema: contract.response } } } },
  }, async c => {
    const context = c.get('context'), principal = context.principal;
    if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId)
      throw new AppError('not_found', 'Gym not found');
    c.header('Cache-Control', 'no-store');
    // Hono cannot infer ComputeInput for an unresolved generic schema; route validation above establishes Q's output.
    const request = c.req as typeof c.req & { valid(target: 'query'): z.output<Q> };
    return c.json(await service.get({ gymId: context.gym.gymId, timezone: context.gym.timezone, clock: context.clock }, request.valid('query')), 200);
  });
}

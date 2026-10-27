// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from 'hono';
import { z } from '@hono/zod-openapi';
import { AppError, type Clock } from '@plaingym/shared';
import { ranksContracts, promotionCriterionSchema, rankSchema } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestEnvironment } from '../../core/context.js';
import type { AttendanceQueries } from '../../core/interfaces/attendance.js';
import type { PromotionCriterionProvider } from '../../core/interfaces/extensions.js';
import { createPromotionCriteria } from './criteria.js';
import { createRanksService } from './ranks.service.js';

type RanksService = ReturnType<typeof createRanksService>;
// TODO: put this documentation on the shared config schema. z.json's recursive
// union otherwise overflows zod-to-openapi. The cloned schema keeps its validation.
const documentedCriteria = z.array(promotionCriterionSchema.extend({
  config: promotionCriterionSchema.shape.config.openapi({ type: 'object', additionalProperties: {} }),
}));
const documentedRank = rankSchema.extend({ criteria: documentedCriteria });
const createRankBody = ranksContracts.createRank.body.extend({ criteria: documentedCriteria });
const updateRankBody = ranksContracts.updateRank.body.safeExtend({ criteria: documentedCriteria.optional() });
const rankResponse = ranksContracts.createRank.response.extend({ data: documentedRank });
const ranksResponse = ranksContracts.listRanks.response.extend({ data: z.array(documentedRank) });
let configured: RanksService | undefined;
/** Runtime injects attendance and optional module providers before serving requests. */
export function configureRanks(options: { attendance: AttendanceQueries; clock: Clock; providers?: readonly PromotionCriterionProvider[] }) {
  const criteria = createPromotionCriteria(options.attendance);
  criteria.registerAll(options.providers ?? []);
  configured = createRanksService({ clock: options.clock, criteria });
  return criteria;
}
function runtimeService(): RanksService {
  if (!configured) throw new AppError('unavailable', 'Ranks are not configured');
  return configured;
}
function staffContext(c: Context<RequestEnvironment>) {
  const context = c.get('context'), principal = context.principal;
  if (principal.kind !== 'staff' || principal.gymId !== context.gym.gymId)
    throw new AppError('not_found', 'Gym not found');
  c.header('Cache-Control', 'no-store');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: principal.userId } };
}
export function createRanksRoutes(read: () => RanksService = runtimeService) {
  return [
    route({ ...ranksContracts.listPrograms, request: { query: ranksContracts.listPrograms.query },
      responses: { 200: { description: 'listPrograms', content: { 'application/json': { schema: ranksContracts.listPrograms.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json(await read().listPrograms(context.gymId, c.req.query()), 200);
    }),
    route({ ...ranksContracts.createProgram, request: { body: { required: true, content: { 'application/json': { schema: ranksContracts.createProgram.body } } } },
      responses: { 200: { description: 'createProgram', content: { 'application/json': { schema: ranksContracts.createProgram.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().createProgram(context, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.updateProgram, request: { params: ranksContracts.updateProgram.params, body: { required: true, content: { 'application/json': { schema: ranksContracts.updateProgram.body } } } },
      responses: { 200: { description: 'updateProgram', content: { 'application/json': { schema: ranksContracts.updateProgram.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().updateProgram(context, c.req.valid('param').id, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.listRankSystems, request: { query: ranksContracts.listRankSystems.query },
      responses: { 200: { description: 'listRankSystems', content: { 'application/json': { schema: ranksContracts.listRankSystems.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json(await read().listRankSystems(context.gymId, c.req.valid('query')), 200);
    }),
    route({ ...ranksContracts.createRankSystem, request: { body: { required: true, content: { 'application/json': { schema: ranksContracts.createRankSystem.body } } } },
      responses: { 200: { description: 'createRankSystem', content: { 'application/json': { schema: ranksContracts.createRankSystem.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().createRankSystem(context, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.updateRankSystem, request: { params: ranksContracts.updateRankSystem.params, body: { required: true, content: { 'application/json': { schema: ranksContracts.updateRankSystem.body } } } },
      responses: { 200: { description: 'updateRankSystem', content: { 'application/json': { schema: ranksContracts.updateRankSystem.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().updateRankSystem(context, c.req.valid('param').id, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.listRanks, request: { query: ranksContracts.listRanks.query },
      responses: { 200: { description: 'listRanks', content: { 'application/json': { schema: ranksResponse } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json(await read().listRanks(context.gymId, c.req.valid('query')), 200);
    }),
    route({ ...ranksContracts.createRank, request: { body: { required: true, content: { 'application/json': { schema: createRankBody } } } },
      responses: { 200: { description: 'createRank', content: { 'application/json': { schema: rankResponse } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().createRank(context, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.updateRank, request: { params: ranksContracts.updateRank.params, body: { required: true, content: { 'application/json': { schema: updateRankBody } } } },
      responses: { 200: { description: 'updateRank', content: { 'application/json': { schema: rankResponse } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().updateRank(context, c.req.valid('param').id, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.listPromotions, request: { query: ranksContracts.listPromotions.query },
      responses: { 200: { description: 'listPromotions', content: { 'application/json': { schema: ranksContracts.listPromotions.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json(await read().listPromotions(context.gymId, c.req.valid('query')), 200);
    }),
    route({ ...ranksContracts.promote, request: { body: { required: true, content: { 'application/json': { schema: ranksContracts.promote.body } } } },
      responses: { 200: { description: 'promote', content: { 'application/json': { schema: ranksContracts.promote.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().promote(context, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.bulkPromote, request: { body: { required: true, content: { 'application/json': { schema: ranksContracts.bulkPromote.body } } } },
      responses: { 200: { description: 'bulkPromote', content: { 'application/json': { schema: ranksContracts.bulkPromote.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json({ data: await read().bulkPromote(context, c.req.valid('json')) }, 200);
    }),
    route({ ...ranksContracts.eligibility, request: { query: ranksContracts.eligibility.query },
      responses: { 200: { description: 'eligibility', content: { 'application/json': { schema: ranksContracts.eligibility.response } } } },
    }, async (c) => {
      const context = staffContext(c);
      return c.json(await read().eligibility(context.gymId, c.req.query(), c.get('context').gym.enabledModules), 200);
    }),
  ];
}
export const routes = createRanksRoutes();

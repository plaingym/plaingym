// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { linksContracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { campaignService, type CampaignsService } from './campaigns.js';

function mutation(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId)
    throw new AppError('forbidden', 'Staff access required');
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createCampaignRoutes(read: () => CampaignsService = campaignService) {
  const create = linksContracts.createCampaign, list = linksContracts.listCampaigns, get = linksContracts.getCampaign;
  const recipients = linksContracts.listCampaignRecipients, remind = linksContracts.remindCampaign;
  return [
    route({ ...create, request: { body: { required: true, content: { 'application/json': { schema: create.body } } } },
      responses: { 200: { description: 'Campaign queued for delivery', content: { 'application/json': { schema: create.response } } } },
    }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().create(mutation(c.get('context')), c.req.valid('json')) }, 200);
    }),
    route({ ...list, request: { query: list.query },
      responses: { 200: { description: 'Campaign progress', content: { 'application/json': { schema: list.response } } } },
    }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await read().list(c.get('context').gym.gymId, c.req.valid('query')), 200);
    }),
    route({ ...get, request: { params: get.params },
      responses: { 200: { description: 'Campaign progress', content: { 'application/json': { schema: get.response } } } },
    }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().get(c.get('context').gym.gymId, c.req.valid('param').campaignId) }, 200);
    }),
    route({ ...recipients, request: { params: recipients.params, query: recipients.query },
      responses: { 200: { description: 'Campaign recipients', content: { 'application/json': { schema: recipients.response } } } },
    }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(await read().recipients(c.get('context').gym.gymId, c.req.valid('param').campaignId, c.req.valid('query')), 200);
    }),
    route({ ...remind, request: { params: remind.params },
      responses: { 200: { description: 'Pending recipient reminders queued', content: { 'application/json': { schema: remind.response } } } },
    }, async c => {
      c.header('Cache-Control', 'no-store');
      return c.json({ data: await read().remindCampaign(mutation(c.get('context')), c.req.valid('param').campaignId) }, 200);
    }),
  ];
}
export const routes = createCampaignRoutes();

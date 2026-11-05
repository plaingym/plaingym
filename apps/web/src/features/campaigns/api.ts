// SPDX-License-Identifier: AGPL-3.0-only
import { linksContracts, membersContracts, type CampaignRecipientState, type CreateLinkCampaignRequest, type Household,
  type HouseholdsNeedingCardResponse } from '@plaingym/shared/contracts';
import { api, ApiError } from '../../lib/api.js';

function checked<T>(result: { response: Response; data?: T; error?: unknown }): T {
  if (!result.response.ok || result.data === undefined) {
    const error = result.error as { error?: { code?: unknown } } | undefined;
    throw new ApiError(result.response.status, error?.error?.code === 'invalid_request' ? 'invalid_request' : 'request_failed');
  }
  return result.data;
}
export const campaignClient = {
  async needsCard(households: Household[]) {
    return householdsNeedingCard(households, async offset => linksContracts.listHouseholdsNeedingCard.response.parse(
      checked(await api.GET('/api/link-campaign-households/needing-card', { params: { query: { limit: 100, offset } } }))));
  },
  async list(offset = 0) {
    return linksContracts.listCampaigns.response.parse(checked(await api.GET('/api/link-campaigns', { params: { query: { limit: 20, offset } } })));
  },
  async get(campaignId: string) {
    return linksContracts.getCampaign.response.parse(checked(await api.GET('/api/link-campaigns/{campaignId}', { params: { path: { campaignId } } }))).data;
  },
  async recipients(campaignId: string, state: CampaignRecipientState | undefined, offset = 0) {
    return linksContracts.listCampaignRecipients.response.parse(checked(await api.GET('/api/link-campaigns/{campaignId}/recipients',
      { params: { path: { campaignId }, query: { ...(state ? { state } : {}), limit: 20, offset } } })));
  },
  async create(input: CreateLinkCampaignRequest) {
    const body = linksContracts.createCampaign.body.parse(input);
    return linksContracts.createCampaign.response.parse(checked(await api.POST('/api/link-campaigns', { body }))).data;
  },
  async remind(campaignId: string) {
    return linksContracts.remindCampaign.response.parse(checked(await api.POST('/api/link-campaigns/{campaignId}/remind', { params: { path: { campaignId } } }))).data;
  },
  async households() {
    const result: Household[] = [];
    for (let offset = 0; ; ) {
      const page = membersContracts.listHouseholds.response.parse(checked(await api.GET('/api/households', { params: { query: { offset, limit: 100 } } })));
      result.push(...page.data); offset += page.data.length;
      if (offset >= page.pagination.total) return result;
      if (!page.data.length) throw new Error('Incomplete household list');
    }
  },
};
export type CampaignClient = typeof campaignClient;

/**
 * Loaded only when the filter is requested: the server answers for the whole gym a page of 100 at a time, so the request
 * count follows the households without a card, not every household. Keeps the editor's households, in their order.
 */
export async function householdsNeedingCard(households: Household[], load: (offset: number) => Promise<HouseholdsNeedingCardResponse>) {
  const missing = new Set<string>();
  for (let offset = 0; ; ) {
    const page = await load(offset);
    for (const row of page.data) missing.add(row.householdId);
    offset += page.data.length;
    if (offset >= page.pagination.total) break;
    if (!page.data.length) throw new Error('Incomplete household list');
  }
  return households.filter(h => missing.has(h.id)).map(h => h.id);
}

// SPDX-License-Identifier: AGPL-3.0-only
import { billingContracts, linksContracts, membersContracts, type CampaignRecipientState, type CreateLinkCampaignRequest, type Household } from '@plaingym/shared/contracts';
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
    return householdsNeedingCard(households, async (householdId, offset) =>
      billingContracts.listPaymentMethods.response.parse(checked(await api.GET('/api/billing/households/{householdId}/payment-methods',
        { params: { path: { householdId }, query: { limit: 100, offset } } }))));
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

/** Load only when the filter is requested, with bounded concurrency and complete pagination. */
export async function householdsNeedingCard(households: Household[], load: (householdId: string, offset: number) =>
  Promise<ReturnType<typeof billingContracts.listPaymentMethods.response.parse>>) {
  const missing = new Set<string>();
  let next = 0;
  async function worker() {
    while (next < households.length) {
      const household = households[next++]!;
      for (let offset = 0; ; ) {
        const page = await load(household.id, offset);
        if (page.data.some(card => card.revokedAt === null)) break;
        offset += page.data.length;
        if (offset >= page.pagination.total) { missing.add(household.id); break; }
        if (!page.data.length) throw new Error('Incomplete payment method list');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, households.length) }, () => worker()));
  return households.filter(h => missing.has(h.id)).map(h => h.id);
}

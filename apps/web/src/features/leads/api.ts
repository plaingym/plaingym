// SPDX-License-Identifier: AGPL-3.0-only
import * as c from '@plaingym/shared/contracts';
import { memberRequest } from '../members/api.js';
import { bookingClient } from '../bookings/client.js';

export type Lead = ReturnType<typeof c.leadSchema.parse>;
export const leadClient = {
  async list(input: c.LeadListQuery, signal?: AbortSignal) {
    const query = c.leadListQuerySchema.parse(input);
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) value.forEach(item => params.append(key, item));
      else if (value !== undefined) params.set(key, String(value));
    }
    return memberRequest(c.leadListResponseSchema, '/api/leads?' + params, 'GET', undefined, signal);
  },
  async edit(lead: Lead, patch: Omit<c.UpdateLeadRequest, 'revision'>) {
    return (await memberRequest(c.leadResponseSchema, `/api/leads/${lead.memberId}`, 'PATCH', c.updateLeadRequestSchema.parse({ ...patch, revision: lead.revision }))).data;
  },
  async lost(lead: Lead, reason: string) {
    return (await memberRequest(c.leadResponseSchema, `/api/leads/${lead.memberId}/lost`, 'POST', c.loseLeadRequestSchema.parse({ reason, revision: lead.revision }))).data;
  },
  async reopen(lead: Lead) {
    return (await memberRequest(c.leadResponseSchema, `/api/leads/${lead.memberId}/reopen`, 'POST', c.reopenLeadRequestSchema.parse({ revision: lead.revision }))).data;
  },
  sessions: bookingClient.sessions,
  book: bookingClient.book,
};
export type LeadClient = typeof leadClient;

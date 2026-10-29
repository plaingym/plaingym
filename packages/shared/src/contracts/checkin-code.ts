// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { portalMemberParamsSchema, portalRegenerateCheckinRequestSchema, portalCheckinCodeResponseSchema } from './portal.js';

export const checkinCodeResponseSchema = z.strictObject({ data: portalCheckinCodeResponseSchema.shape.data.extend({ code: z.string().min(1).nullable() }) });
const common = { path: '/api/members/{memberId}/checkin-code', permission: { kind: 'staff', capability: 'members.manage' },
  params: portalMemberParamsSchema, response: checkinCodeResponseSchema } as const;
export const checkinCodeContracts = {
  read: { ...common, method: 'get' },
  regenerate: { ...common, method: 'post', body: portalRegenerateCheckinRequestSchema },
  revoke: { ...common, method: 'delete', body: portalRegenerateCheckinRequestSchema },
} as const;

export type CheckinCodeResponse = z.infer<typeof checkinCodeResponseSchema>;

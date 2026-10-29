// SPDX-License-Identifier: AGPL-3.0-only
import { kioskCheckinResponseSchema, portalCheckinCodeResponseSchema, type PortalCheckinCodeResponse } from '@plaingym/shared/contracts';
import { KioskAuthError } from './api.js';

// TODO(CCR): use the shared additive staff contract when published.
const staffResponse = portalCheckinCodeResponseSchema.extend({ data: portalCheckinCodeResponseSchema.shape.data.extend({
  code: portalCheckinCodeResponseSchema.shape.data.shape.code.nullable(),
}) });
export type CheckinCode = Omit<PortalCheckinCodeResponse['data'], 'code'> & { code: string | null };
export class QrRequestError extends Error { constructor(readonly status: number) { super('Request failed'); } }
export async function qrCheckin(token: string, code: string, sessionId?: string | null) {
  const response = await fetch('/api/kiosk/checkin/qr', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ code, ...(sessionId === undefined ? {} : { sessionId }) }) });
  if ([401, 403, 404].includes(response.status)) throw new KioskAuthError('Device not authorized');
  if (!response.ok) throw new QrRequestError(response.status);
  return kioskCheckinResponseSchema.parse(await response.json()).data;
}
export async function staffCheckinCode(memberId: string, action: 'read' | 'regenerate' | 'revoke' = 'read', revision?: number): Promise<CheckinCode> {
  const response = await fetch('/api/members/' + encodeURIComponent(memberId) + '/checkin-code', {
    method: action === 'read' ? 'GET' : action === 'revoke' ? 'DELETE' : 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', ...(action === 'read' ? {} : { 'Content-Type': 'application/json' }) },
    ...(action === 'read' ? {} : { body: JSON.stringify({ revision }) }),
  });
  if (!response.ok) throw new QrRequestError(response.status);
  return staffResponse.parse(await response.json()).data;
}

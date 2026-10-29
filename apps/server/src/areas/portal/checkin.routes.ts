// SPDX-License-Identifier: AGPL-3.0-only
import { portalContracts } from '@plaingym/shared/contracts';
import type { RouteRegistration } from '../../core/registry.js';
import { route } from '../../core/registry.js';
import type { CheckinCodeService } from '../members/checkin-code.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalCheckinService, type PortalCheckinService } from './checkin.js';

let configured: CheckinCodeService | undefined;
/** Runtime passes the same code service as staff and the kiosk, built over the encrypted gym key. */
export function configurePortalCheckin(codes: CheckinCodeService) { configured = codes; }
export function createPortalCheckinRoutes(service: PortalCheckinService = createPortalCheckinService({ codes: () => configured })): RouteRegistration[] {
  const { checkinCode, regenerateCheckin } = portalContracts;
  return [
    route({ ...checkinCode, request: { params: checkinCode.params }, responses: { 200: { description: 'Member check-in code', content: { 'application/json': { schema: checkinCode.response } } } } },
      async c => {
        c.header('Cache-Control', 'no-store');
        return c.json(checkinCode.response.parse({ data: await service.read(portalIdentity(c.get('context')), c.req.valid('param').memberId) }), 200);
      }),
    route({ ...regenerateCheckin, request: { params: regenerateCheckin.params, body: { required: true, content: { 'application/json': { schema: regenerateCheckin.body } } } },
      responses: { 200: { description: 'Regenerated check-in code', content: { 'application/json': { schema: regenerateCheckin.response } } } } },
    async c => {
      c.header('Cache-Control', 'no-store');
      return c.json(regenerateCheckin.response.parse({ data: await service.regenerate(portalIdentity(c.get('context')), c.req.valid('param').memberId, c.req.valid('json')) }), 200);
    }),
  ];
}
export const routes: readonly RouteRegistration[] = createPortalCheckinRoutes();

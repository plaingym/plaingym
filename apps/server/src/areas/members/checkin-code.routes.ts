// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { route } from '../../core/registry.js';
import { checkinCodeContracts as contracts } from './checkin-code.contracts.js';
import { createCheckinCodeService, type CheckinCodeOptions, type CheckinCodeService } from './checkin-code.js';

let configured: CheckinCodeService | undefined;
export function configureCheckinCodes(options: CheckinCodeOptions) { configured = createCheckinCodeService(options); }
export function createCheckinCodeRoutes(service?: CheckinCodeService) {
  const fallback = createCheckinCodeService(), current = () => service ?? configured ?? fallback;
  return Object.entries(contracts).map(([action, contract]) => route({ ...contract,
    request: { params: contract.params, ...('body' in contract ? { body: { required: true, content: { 'application/json': { schema: contract.body } } } } : {}) },
    responses: { 200: { description: 'Member check-in code', content: { 'application/json': { schema: contract.response } } } },
  }, async (c) => {
    c.header('Cache-Control', 'no-store');
    const { gym, principal } = c.get('context');
    if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Resource not found');
    const memberId = contract.params.parse(c.req.param()).memberId;
    const context = { gymId: gym.gymId, actor: { kind: 'user' as const, userId: principal.userId } };
    const data = action === 'read' ? await current().read(gym.gymId, memberId)
      : action === 'revoke' ? await current().revoke(context, memberId, await c.req.json())
      : await current().regenerate(context, memberId, await c.req.json());
    return c.json(contract.response.parse({ data }), 200);
  }));
}
export const routes = createCheckinCodeRoutes();

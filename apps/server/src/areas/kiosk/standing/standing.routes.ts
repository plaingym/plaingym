// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type Clock } from '@plaingym/shared';
import { kioskContracts, kioskStandingContracts } from '@plaingym/shared/contracts';
import type { Context } from 'hono';
import type { RequestEnvironment } from '../../../core/context.js';
import { route, type RouteRegistration } from '../../../core/registry.js';
import type { Uploads } from '../../../infra/storage/index.js';
import type { HouseholdPinSecret } from '../../members/pin.js';
import { createKioskCheckin, type KioskCheckin } from './checkin.js';
import { markKioskPinVerified } from '../devices.auth.js';

let configured: KioskCheckin | undefined;
/** Runtime supplies the gym key for PINs and file storage for photo links before serving requests. */
export function configureKiosk(options: { pinSecret: HouseholdPinSecret; uploadsFor?: (gymId: string) => Promise<Uploads>; clock?: Clock }) {
  configured = createKioskCheckin(options);
}
function device(c: Context<RequestEnvironment>) {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'kiosk' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  c.header('Cache-Control', 'no-store');
  return { gymId: gym.gymId, deviceId: principal.deviceId };
}
function staff(c: Context<RequestEnvironment>) {
  const { gym, principal } = c.get('context');
  if (principal.kind !== 'staff' || principal.gymId !== gym.gymId) throw new AppError('not_found', 'Gym not found');
  c.header('Cache-Control', 'no-store');
  return gym.gymId;
}
/** Tests pass a service; otherwise routes use the runtime composition, and without one PIN check-in fails closed. */
export function createKioskCheckinRoutes(service?: KioskCheckin): readonly RouteRegistration[] {
  const fallback = createKioskCheckin();
  const current = () => service ?? configured ?? fallback;
  const lookup = kioskContracts.lookup, checkin = kioskContracts.checkinNamePin, standing = kioskStandingContracts.memberStanding;
  return [
    route({ ...lookup, request: { body: { required: true, content: { 'application/json': { schema: lookup.body } } } },
      responses: { 200: { description: 'Household members, or the front desk', content: { 'application/json': { schema: lookup.response } } } },
    }, async (c) => { const { gymId } = device(c); return c.json({ data: await current().lookup(gymId, c.req.valid('json'), () => markKioskPinVerified(c.req.raw)) }, 200); }),
    route({ ...checkin, request: { body: { required: true, content: { 'application/json': { schema: checkin.body } } } },
      responses: { 200: { description: 'One result per selected member', content: { 'application/json': { schema: checkin.response } } } },
    }, async (c) => { const { gymId, deviceId } = device(c); return c.json({ data: await current().checkin(gymId, deviceId, c.req.valid('json'), () => markKioskPinVerified(c.req.raw)) }, 200); }),
    route({ ...standing, request: { params: standing.params },
      responses: { 200: { description: 'Kiosk standing and its reasons', content: { 'application/json': { schema: standing.response } } } },
    }, async (c) => c.json({ data: await current().memberStanding(staff(c), c.req.valid('param').memberId) }, 200)),
  ];
}
export const routes = createKioskCheckinRoutes();

// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import { portalIdentity } from './auth.permissions.js';
import { createPortalBookingService } from './bookings.js';
import type { BookingDelivery } from '../bookings/bookings.delivery.js';

let delivery: BookingDelivery | undefined;
export function configurePortalBookingRoutes(value: BookingDelivery) { delivery = value; }
export function createPortalBookingRoutes(service = createPortalBookingService({ delivery: () => delivery })) {
  const { listSelf, createSelf, cancelSelf, listHouseholdMember, createHouseholdMember, cancelHouseholdMember } = contracts;
  return [
    route({ ...listSelf, request: { query: listSelf.query }, responses: { 200: { description: 'My bookings', content: { 'application/json': { schema: listSelf.response } } } } },
      async c => { c.header('Cache-Control', 'no-store'); return c.json(await service.list(portalIdentity(c.get('context')), c.req.valid('query')), 200); }),
    route({ ...createSelf, request: { body: { required: true, content: { 'application/json': { schema: createSelf.body } } } }, responses: { 200: { description: 'My booking', content: { 'application/json': { schema: createSelf.response } } } } },
      async c => c.json({ data: await service.book(portalIdentity(c.get('context')), c.req.valid('json')) }, 200)),
    route({ ...cancelSelf, request: { params: cancelSelf.params }, responses: { 200: { description: 'My cancelled booking', content: { 'application/json': { schema: cancelSelf.response } } } } },
      async c => c.json({ data: await service.cancel(portalIdentity(c.get('context')), c.req.valid('param').id) }, 200)),
    route({ ...listHouseholdMember, request: { params: listHouseholdMember.params, query: listHouseholdMember.query }, responses: { 200: { description: 'Household member bookings', content: { 'application/json': { schema: listHouseholdMember.response } } } } },
      async c => { c.header('Cache-Control', 'no-store'); return c.json(await service.list(portalIdentity(c.get('context')), c.req.valid('query'), c.req.valid('param').memberId), 200); }),
    route({ ...createHouseholdMember, request: { params: createHouseholdMember.params, body: { required: true, content: { 'application/json': { schema: createHouseholdMember.body } } } }, responses: { 200: { description: 'Household member booking', content: { 'application/json': { schema: createHouseholdMember.response } } } } },
      async c => c.json({ data: await service.book(portalIdentity(c.get('context')), c.req.valid('json'), c.req.valid('param').memberId) }, 200)),
    route({ ...cancelHouseholdMember, request: { params: cancelHouseholdMember.params }, responses: { 200: { description: 'Cancelled household member booking', content: { 'application/json': { schema: cancelHouseholdMember.response } } } } },
      async c => c.json({ data: await service.cancel(portalIdentity(c.get('context')), c.req.valid('param').id, c.req.valid('param').memberId) }, 200)),
  ];
}
export const routes = createPortalBookingRoutes();

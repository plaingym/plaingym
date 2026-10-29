// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { notFound } from '../../core/interfaces/common.js';
import { createBookingService } from './bookings.js';
import type { BookingDelivery } from './bookings.delivery.js';

let delivery: BookingDelivery | undefined;
export function configureBookingRoutes(value: BookingDelivery) { delivery = value; }
function staff(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) notFound();
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
export function createBookingRoutes(service = createBookingService(), readDelivery = () => delivery) {
  const { list, create, cancel, roster } = contracts;
  return [
    route({ ...list, request: { query: list.query }, responses: { 200: { description: 'Bookings', content: { 'application/json': { schema: list.response } } } } },
      async c => c.json(await service.list(staff(c.get('context')).gymId, c.req.valid('query')), 200)),
    route({ ...create, request: { body: { required: true, content: { 'application/json': { schema: create.body } } } }, responses: { 200: { description: 'Booking', content: { 'application/json': { schema: create.response } } } } },
      async c => c.json({ data: await service.book(staff(c.get('context')), c.req.valid('json')) }, 200)),
    route({ ...cancel, request: { params: cancel.params }, responses: { 200: { description: 'Cancelled booking', content: { 'application/json': { schema: cancel.response } } } } }, async c => {
      const actor = staff(c.get('context')), booking = await service.cancel(actor, c.req.valid('param').id);
      await readDelivery()?.request(actor.gymId, booking.sessionId, booking.id);
      return c.json({ data: booking }, 200);
    }),
    route({ ...roster, request: { params: roster.params, query: roster.query }, responses: { 200: { description: 'Bookings and check-ins', content: { 'application/json': { schema: roster.response } } } } },
      async c => c.json(await service.roster(staff(c.get('context')).gymId, c.req.valid('param').sessionId, c.req.valid('query')), 200)),
  ];
}
export const routes = createBookingRoutes();

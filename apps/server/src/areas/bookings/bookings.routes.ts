// SPDX-License-Identifier: AGPL-3.0-only
import { bookingsContracts as contracts } from '@plaingym/shared/contracts';
import { route } from '../../core/registry.js';
import type { RequestContext } from '../../core/context.js';
import { notFound } from '../../core/interfaces/common.js';
import { AppError } from '@plaingym/shared';
import type { MiddlewareHandler } from 'hono';
import { createBookingService, type BookingCancelNoticeRequest } from './bookings.js';
import type { BookingDelivery } from './bookings.delivery.js';

let delivery: BookingDelivery | undefined;
export function configureBookingRoutes(value: BookingDelivery) { delivery = value; }
function staff(context: RequestContext) {
  if (context.principal.kind !== 'staff' || context.principal.gymId !== context.gym.gymId) notFound();
  return { gymId: context.gym.gymId, actor: { kind: 'user' as const, userId: context.principal.userId } };
}
/** With no bytes there is no representation to validate, even if a client supplied a content type. */
const allowEmptyBody: MiddlewareHandler = async (c, next) => {
  if (c.req.header('content-type') && (await c.req.arrayBuffer()).byteLength === 0) {
    c.req.raw.headers.delete('content-type');
  }
  await next();
};
export function createBookingRoutes(service = createBookingService(), readDelivery = () => delivery) {
  const { list, create, cancel, roster } = contracts;
  return [
    route({ ...list, request: { query: list.query }, responses: { 200: { description: 'Bookings', content: { 'application/json': { schema: list.response } } } } },
      async c => c.json(await service.list(staff(c.get('context')).gymId, c.req.valid('query')), 200)),
    route({ ...create, request: { body: { required: true, content: { 'application/json': { schema: create.body } } } }, responses: { 200: { description: 'Booking', content: { 'application/json': { schema: create.response } } } } },
      async c => {
        const actor = staff(c.get('context')), result = await service.book(actor, c.req.valid('json'));
        await readDelivery()?.enqueueNotices(actor.gymId, result.promoted.map(row => row.id));
        return c.json({ data: result.booking }, 200);
      }),
    route({ ...cancel, middleware: allowEmptyBody, request: { params: cancel.params, body: { required: false, content: { 'application/json': { schema: cancel.body } } } },
      responses: { 200: { description: 'Cancelled booking', content: { 'application/json': { schema: cancel.response } } } } }, async c => {
      const actor = staff(c.get('context')), body = c.req.valid('json');
      let notice: BookingCancelNoticeRequest | undefined;
      if (body.notify) {
        const configured = readDelivery();
        if (!configured) throw new AppError('unavailable', 'Booking notices are not configured');
        // Without a choice, both channels go. The note belongs to the email.
        const channels = body.channels ?? ['email', 'sms'];
        notice = { channels, note: channels.includes('email') ? body.note ?? '' : '', enqueue: configured.enqueueCancelNotice };
      }
      const booking = await service.cancel(actor, c.req.valid('param').id, undefined, notice);
      // With a notice, the cancelling transaction already queued this promotion ahead of it; the same key finds that job.
      await readDelivery()?.requestPromotion(actor.gymId, booking.sessionId, booking.id);
      return c.json({ data: booking }, 200);
    }),
    route({ ...roster, request: { params: roster.params, query: roster.query }, responses: { 200: { description: 'Bookings and check-ins', content: { 'application/json': { schema: roster.response } } } } },
      async c => c.json(await service.roster(staff(c.get('context')).gymId, c.req.valid('param').sessionId, c.req.valid('query')), 200)),
  ];
}
export const routes = createBookingRoutes();

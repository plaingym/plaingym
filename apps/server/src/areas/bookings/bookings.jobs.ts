// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { noticeJob, noticePayload, promotionJob, promotionPayload, type BookingDelivery } from './bookings.delivery.js';

let configured: BookingDelivery | undefined;
export function configureBookingJobs(delivery: BookingDelivery) { configured = delivery; }
export function createBookingJobs(read: () => BookingDelivery | undefined = () => configured): readonly JobRegistration[] {
  function delivery() { if (!read()) throw new Error('Booking jobs are not configured'); return read()!; }
  return [
    { id: promotionJob, async handler(payload, context) { await delivery().promote(context.gymId, promotionPayload.parse(payload).sessionId); } },
    { id: noticeJob, async handler(payload, context) { await delivery().send(context.gymId, noticePayload.parse(payload).bookingId); } },
    { id: 'bookings.recover', cron: '* * * * *', async handler(_payload, context) { await delivery().sweep(context.gymId); } },
  ];
}
export const jobs = createBookingJobs();

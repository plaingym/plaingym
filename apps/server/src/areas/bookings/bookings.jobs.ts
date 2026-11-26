// SPDX-License-Identifier: AGPL-3.0-only
import type { JobRegistration } from '../../core/registry.js';
import { cancelNoticeJob } from './bookings.cancel-notice.js';
import { noticeJob, noticePayload, promotionJob, promotionPayload, type BookingDelivery } from './bookings.delivery.js';

let configured: BookingDelivery | undefined;
export function configureBookingJobs(delivery: BookingDelivery) { configured = delivery; }
export function createBookingJobs(read: () => BookingDelivery | undefined = () => configured): readonly JobRegistration[] {
  function delivery() { if (!read()) throw new Error('Booking jobs are not configured'); return read()!; }
  return [
    { id: promotionJob, async handler(payload, context) { await delivery().promote(context.gymId, promotionPayload.parse(payload).sessionId); } },
    { id: noticeJob, async handler(payload, context) { await delivery().send(context.gymId, noticePayload.parse(payload).bookingId); } },
    // In the notices lane, which no other booking job uses: a notice held by a slow mailer, or waiting for its retry,
    // never takes the default-lane slot that the gym's waitlist promotions are claimed in, and doesn't share a lane
    // with the gym's batch work.
    { id: cancelNoticeJob, lane: 'notices', async handler(payload, context) { await delivery().sendCancelNotice(payload, context.gymId); } },
    { id: 'bookings.recover', cron: '*/5 * * * *', async handler(_payload, context) { await delivery().sweep(context.gymId); } },
  ];
}
export const jobs = createBookingJobs();

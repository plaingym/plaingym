// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { alertPayloadSchema } from '../src/areas/billing/alerts/index.js';
import { noticePayload, promotionPayload } from '../src/areas/bookings/bookings.delivery.js';
import { backupPayload } from '../src/areas/health/backups.jobs.js';
import { exportPayloadSchema } from '../src/areas/imports/export.jobs.js';
import { importPayloadSchema } from '../src/areas/imports/pipeline.jobs.js';
import { campaignPublishPayload, campaignSendPayload } from '../src/areas/links/campaigns.js';
import { storedNoticePayload } from '../src/public/pages/notifications.js';

// A job queued by a newer release waits in the table through a rollback, and the older code runs it (docs/versioning.md).
const id = uuidv7();
it.each([
  ['a card expiry alert', alertPayloadSchema, { kind: 'card_expiry', paymentMethodId: id, cycle: '2026-11-01' }],
  ['a dispute alert', alertPayloadSchema, { kind: 'dispute', invoiceId: id, disputeId: 'dp_1' }],
  ['a waitlist promotion', promotionPayload, { sessionId: id }],
  ['a booking notice', noticePayload, { bookingId: id }],
  ['a backup', backupPayload, { kind: 'hourly' }],
  ['an export', exportPayloadSchema, { id }],
  ['an import', importPayloadSchema, { id }],
  ['a campaign publication', campaignPublishPayload, { campaignId: id }],
  ['a campaign send', campaignSendPayload, { campaignId: id, linkId: id, occurrence: 'initial' }],
  ['a public intake notice', storedNoticePayload, { kind: 'trial', memberId: id }],
])('reads %s a newer release added a key to, without the key', (_name, schema, payload) => {
  expect(schema.parse({ ...payload, newerKey: true })).toEqual(payload);
});

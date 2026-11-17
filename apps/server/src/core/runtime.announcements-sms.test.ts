// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test switches the sandbox gym's member settings in real PostgreSQL.
import { gyms, smsOutbox, uuidv7 } from '@plaingym/db';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;
const phone = '+12025550177';

it('texts an announcement through the runtime composition, into the sandbox outbox', async () => {
  const sandbox = app.sandbox, gymId = sandbox.gymId;
  const headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin, 'content-type': 'application/json' };
  const call = (path: string, body: unknown) => app.runtime.app.request(sandbox.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const texts = () => database.forGym(gymId, tx => tx.select().from(smsOutbox));

  // Quiet hours are 08:00 to 21:00 in the gym's timezone: pick a zone where it is midday now, whatever time the test runs.
  const offset = 12 - clock.now().getUTCHours();
  const timezone = offset === 0 ? 'Etc/UTC' : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
  await database.forGym(gymId, tx => tx.update(gyms).set({ timezone, memberEmailsEnabled: true, memberSmsEnabled: true }).where(eq(gyms.id, gymId)));
  await factory('members', gymId, { status: 'active', email: uuidv7() + '@example.test', phone, phoneE164: phone,
    smsAnnouncementsConsentAt: clock.now(), smsAnnouncementsConsentSource: 'portal' });
  const draft = { subject: 'Closed Monday', body: 'No classes Monday.', sms: { body: 'No classes Monday.' } };

  // The routes see the runtime's provider: the preview counts texts instead of refusing with no_provider.
  const preview = await call('/api/announcements/preview', draft);
  expect(preview.status, await preview.clone().text()).toBe(200);
  expect((await preview.json() as { data: { smsRecipientCount: number } }).data.smsRecipientCount).toBeGreaterThan(0);

  const before = (await texts()).length;
  const sent = await call('/api/announcements/send', { ...draft, sendGeneration: uuidv7(), confirm: true });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const { data: announcement } = await sent.json() as { data: { id: string } };
  expect(app.batchJobs.has('announcements.send-sms')).toBe(true);
  const context = { gymId, clock, timezone, jobId: uuidv7(), attempt: 1 };
  await app.handlers.get('announcements.send')!({ announcementId: announcement.id }, context);
  await app.handlers.get('announcements.send-sms')!({ announcementId: announcement.id }, context);
  const delivered = (await texts()).slice(before).filter(text => text.recipient === phone);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]!.body).toContain(draft.sms.body);
  expect(delivered[0]!.body).toContain('Reply STOP to opt out');

  // A retried job texts nothing more.
  await app.handlers.get('announcements.send-sms')!({ announcementId: announcement.id }, context);
  expect((await texts()).slice(before).filter(text => text.recipient === phone)).toHaveLength(1);
});

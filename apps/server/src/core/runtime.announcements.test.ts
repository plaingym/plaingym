// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test reads staff logins and switches the sandbox gym's member-email setting in real PostgreSQL.
import { announcementRecipients, authUser, emailOutbox, gyms, staffRoles, uuidv7 } from '@plaingym/db';
import { SmtpEmail } from '../infra/email/index.js';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;
const draft = { subject: 'Closed Monday', body: 'No classes Monday.\n\nhttps://demo.example.test/classes' };

it('sends announcements through the runtime composition to the demo outbox, never SMTP', async () => {
  const sandbox = app.sandbox, headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin, 'content-type': 'application/json' };
  const smtp = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const call = (path: string, body: unknown) => app.runtime.app.request(sandbox.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const setSwitch = (memberEmailsEnabled: boolean) => database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled }).where(eq(gyms.id, sandbox.gymId)));

  // The routes are mounted and configured (not 503), and refuse while the go-live member-email switch is off.
  await setSwitch(false);
  const refused = await call('/api/announcements/preview', draft);
  expect(refused.status).toBe(409);

  await setSwitch(true);
  const preview = await call('/api/announcements/preview', draft);
  expect(preview.status).toBe(200);
  const { data: { recipientCount } } = await preview.json() as { data: { recipientCount: number } };
  expect(recipientCount).toBeGreaterThan(0);

  // The test copy goes to the signed-in sender's own login address, found by the runtime's trusted lookup.
  const roles = await database.forGym(sandbox.gymId, tx => tx.select({ userId: staffRoles.userId }).from(staffRoles));
  const staff = (await database.system.db.select({ email: authUser.email }).from(authUser)
    .where(inArray(authUser.id, roles.map(role => role.userId)))).map(row => row.email);
  expect(staff.length).toBeGreaterThan(0);
  expect((await call('/api/announcements/test', draft)).status).toBe(200);
  const tested = (await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox))).filter(message => message.subject.includes('Closed Monday'));
  expect(tested).toHaveLength(1);
  expect(staff).toContain(tested[0]!.recipient);

  // A confirmed send queues the registered batch job; running it delivers one copy per recipient to the outbox.
  const before = (await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox))).length;
  const sent = await call('/api/announcements/send', { ...draft, sendGeneration: uuidv7(), confirm: true });
  expect(sent.status).toBe(200);
  const { data: announcement } = await sent.json() as { data: { id: string } };
  expect(app.batchJobs.has('announcements.send')).toBe(true);
  await app.handlers.get('announcements.send')!({ announcementId: announcement.id }, { gymId: sandbox.gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
  const recipients = await database.forGym(sandbox.gymId, tx => tx.select().from(announcementRecipients));
  expect(recipients).toHaveLength(recipientCount);
  expect(recipients.map(row => [row.state, row.reason])).toEqual(recipients.map(() => ['sent', null]));
  expect((await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox))).length).toBe(before + recipientCount);
  expect(smtp).not.toHaveBeenCalled();
});

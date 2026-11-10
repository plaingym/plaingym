// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test switches the sandbox gym's member-email setting in real PostgreSQL.
import { classBookings, classSessions, emailOutbox, gyms, members, uuidv7 } from '@plaingym/db';
import { SmtpEmail } from '../infra/email/index.js';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database } = app;

it('cancels a session with the notice option through the runtime composition, mailing the demo outbox and never SMTP', async () => {
  const sandbox = app.sandbox, headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin, 'content-type': 'application/json' };
  const smtp = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));

  // A scheduled session that has a member with an email address booked on it.
  const booked = await database.forGym(sandbox.gymId, tx => tx.select({ session: classSessions, memberId: classBookings.memberId }).from(classBookings)
    .innerJoin(classSessions, eq(classBookings.sessionId, classSessions.id)).innerJoin(members, eq(classBookings.memberId, members.id))
    .where(and(eq(classBookings.status, 'booked'), eq(classSessions.status, 'scheduled'), isNotNull(members.email))).limit(1));
  expect(booked).toHaveLength(1);
  const { session } = booked[0]!;

  // The cancel route accepts the notice option (not 503: the service is configured) and queues the registered job.
  const cancelled = await app.runtime.app.request(`${sandbox.origin}/api/schedule/sessions/${session.id}/cancel`, {
    method: 'POST', headers, body: JSON.stringify({ revision: session.revision, notify: true, note: 'Coach is ill.' }) });
  expect(cancelled.status, await cancelled.clone().text()).toBe(200);
  expect(app.handlers.has('announcements.cancellation')).toBe(true);

  // Delivery honors the go-live member-email switch, which a fresh sandbox has off.
  await database.forGym(sandbox.gymId, tx => tx.update(gyms).set({ memberEmailsEnabled: true }).where(eq(gyms.id, sandbox.gymId)));
  const before = (await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox))).length;
  await app.handlers.get('announcements.cancellation')!(
    { sessionId: session.id, memberIds: [booked[0]!.memberId], note: 'Coach is ill.' },
    { gymId: sandbox.gymId, clock, timezone: 'UTC', jobId: uuidv7(), attempt: 1 });
  const outbox = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox));
  expect(outbox.length).toBeGreaterThan(before);
  expect(smtp).not.toHaveBeenCalled();
});

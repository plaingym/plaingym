// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq, isNotNull } from 'drizzle-orm';
// eslint-disable-next-line database/system-tables -- Composition test switches the sandbox gym's member settings in real PostgreSQL.
import { classBookings, classSessions, gyms, members, smsOutbox, uuidv7 } from '@plaingym/db';
import { clock, TestClock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;
const phone = '+12025550123';

it('texts a cancelled class and a card expiry through the runtime composition, into the sandbox outbox', async () => {
  const sandbox = app.sandbox, gymId = sandbox.gymId;
  const headers = { ...app.headers(sandbox, await app.login('owner')), origin: sandbox.origin, 'content-type': 'application/json' };
  const run = (name: string, payload: unknown) => {
    const handler = app.handlers.get(name);
    expect(handler, name).toBeDefined();
    return handler!(payload, { gymId, timezone: 'UTC', clock, jobId: uuidv7(), attempt: 1 });
  };
  const texts = () => database.forGym(gymId, tx => tx.select().from(smsOutbox));
  await database.forGym(gymId, tx => tx.update(gyms).set({ timezone: 'UTC', billingEnabled: true, memberSmsEnabled: true })
    .where(eq(gyms.id, gymId)));

  // The cancellation job texts a booked member's own consented phone.
  const [booked] = await database.forGym(gymId, tx => tx.select({ session: classSessions, memberId: classBookings.memberId })
    .from(classBookings).innerJoin(classSessions, eq(classBookings.sessionId, classSessions.id))
    .innerJoin(members, eq(classBookings.memberId, members.id))
    .where(and(eq(classBookings.status, 'booked'), eq(classSessions.status, 'scheduled'), isNotNull(members.email))).limit(1));
  expect(booked).toBeDefined();
  await database.forGym(gymId, tx => tx.update(members).set({ phone, phoneE164: phone, smsNoticesConsentAt: clock.now(),
    smsNoticesConsentSource: 'staff' }).where(eq(members.id, booked!.memberId)));
  const { session } = booked!;
  const cancel = await app.runtime.app.request(`${sandbox.origin}/api/schedule/sessions/${session.id}/cancel`, {
    method: 'POST', headers, body: JSON.stringify({ revision: session.revision, notify: true, note: '' }) });
  expect(cancel.status, await cancel.clone().text()).toBe(200);
  const before = (await texts()).length;
  await run('announcements.cancellation', { sessionId: session.id, memberIds: [booked!.memberId], note: '' });
  const cancelled = (await texts()).slice(before);
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]!.recipient).toBe(phone);

  // The card-expiry alert texts the household's consented billing phone.
  const now = vi.spyOn(clock, 'now').mockImplementation(() => new TestClock('2026-11-01T17:00:00Z').now());
  try {
    const home = await factory('households', gymId, { email: 'runtime.sms.payer@example.invalid', phone, phoneE164: phone,
      smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
    const member = await factory('members', gymId, { householdId: home.id });
    await factory('memberships', gymId, { householdId: home.id, memberId: member.id, status: 'active',
      nextDueOn: '2026-12-01', startsOn: '2026-01-01' });
    const card = await factory('paymentMethods', gymId, { householdId: home.id, isDefault: true, expiryMonth: 11, expiryYear: 2026 });
    const beforeCard = (await texts()).length;
    await run('billing.alerts.send', { kind: 'card_expiry', paymentMethodId: card.id, cycle: '2026-12-01' });
    const expiry = (await texts()).slice(beforeCard);
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.recipient).toBe(phone);
  } finally { now.mockRestore(); }
});

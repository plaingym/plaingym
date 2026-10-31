// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { attendances, classBookings, classSessions, emailOutbox, households, members, uuidv7 } from '@plaingym/db';
import { SmtpEmail } from '../infra/email/index.js';
import { clock } from './clock.js';
import { useDemoRuntime } from './runtime.fixture.test-helper.js';

const app = useDemoRuntime({ sandbox: true }), { database, factory } = app;

it('delivers portal invitations to the demo outbox on the canonical gym origin', async () => {
  const sandbox = app.sandbox, ownerCookie = await app.login('owner');
  const send = vi.spyOn(SmtpEmail.prototype, 'sendEmail').mockRejectedValue(new Error('SMTP must not run'));
  const home = await factory('households', sandbox.gymId), email = 'portal.invite@example.invalid';
  const response = await app.post(`/api/households/${home.id}/portal-invitations`, {
    email, scope: 'payer', delivery: 'email',
  }, sandbox.origin, { cookie: ownerCookie });
  expect(response.status).toBe(200);
  const messages = await database.forGym(sandbox.gymId, tx => tx.select().from(emailOutbox).where(eq(emailOutbox.recipient, email)));
  expect(messages).toHaveLength(1);
  expect(messages[0]!.text).toContain(sandbox.origin + '/portal/claim#');
  expect(send).not.toHaveBeenCalled();
});
it('serves rank and import routes through the runtime composition', async () => {
  const sandbox = app.sandbox, headers = app.headers(sandbox, await app.login('owner'));
  // Ranks answer 503 until configured with attendance queries.
  expect((await app.runtime.app.request(sandbox.origin + '/api/programs', { headers })).status).toBe(200);
  // Import and export routes exist only when composed with storage and the job queue.
  const document = await (await app.runtime.app.request(sandbox.origin + '/api/openapi.json', { headers })).json() as { paths: Record<string, unknown> };
  expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(['/api/imports/uploads', '/api/exports', '/api/uploads/download']));
  // Household PINs hash with the gym's own key once the runtime composes members.
  const homeId = uuidv7();
  await database.forGym(sandbox.gymId, (tx) => tx.insert(households).values({ id: homeId, gymId: sandbox.gymId, name: 'PIN family' }));
  const pin = await app.runtime.app.request(sandbox.origin + '/api/households/' + homeId + '/pin', { method: 'PUT',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: 1, pin: '2468' }) });
  expect(pin.status).toBe(200);
  const [stored] = await database.forGym(sandbox.gymId, (tx) => tx.select({ pinHash: households.pinHash }).from(households).where(eq(households.id, homeId)));
  expect(stored!.pinHash).toMatch(/^[a-f0-9]{64}$/);
});
it('serves staff, dashboard, go-live, and waiver routes through the runtime composition', async () => {
  const sandbox = app.sandbox, headers = app.headers(sandbox, await app.login('owner'));
  // Each fails until the runtime configures it.
  for (const path of ['/api/staff/profiles', '/api/dashboard', '/api/settings/go-live', '/api/waivers/templates', '/api/waivers/signatures'])
    expect((await app.runtime.app.request(sandbox.origin + path, { headers })).status, path).toBe(200);
  // The kiosk PIN-limit widget is one of the runtime's dashboard providers.
  expect((await (await app.runtime.app.request(sandbox.origin + '/api/dashboard', { headers })).json()).data.widgets)
    .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'kiosk.pin-limits', kind: 'count', count: 0 })]));
  // Demo invitations go to the in-app outbox; printed ones return a link on the gym's own origin.
  const invite = await app.runtime.app.request(sandbox.origin + '/api/staff/invitations', { method: 'POST',
    headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new.coach@example.invalid', role: 'coach', delivery: 'print' }) });
  expect(invite.status).toBe(200);
  const { data } = await invite.json() as { data: { invitationUrl: string } };
  expect(new URL(data.invitationUrl).origin).toBe(sandbox.origin);
});
it('issues, scans, replaces and revokes QR codes through the production runtime with real bookings', async () => {
  const sandbox = app.sandbox, ownerCookie = await app.login('owner');
  // Marcus is active with the seeded waiver signed, so the real standing providers pass.
  const [row] = await database.forGym(sandbox.gymId, tx => tx.select().from(members).where(eq(members.firstName, 'Marcus')));
  expect(row).toBeDefined();
  const member = row!;
  const session = await factory('classSessions', sandbox.gymId, {
    startsAt: new Date(clock.now().getTime() - 300_000), endsAt: new Date(clock.now().getTime() + 3_600_000),
  });
  await factory('classBookings', sandbox.gymId, { memberId: member.id, sessionId: session.id, status: 'booked' });
  try {
    const path = `/api/members/${member.id}/checkin-code`;
    const issued = await app.post(path, { revision: member.revision }, sandbox.origin, { cookie: ownerCookie });
    expect(issued.status, await issued.clone().text()).toBe(200);
    const { data: first } = await issued.json();
    expect(first.code).toMatch(/^pgci1_/);
    const headers = app.headers(sandbox, ownerCookie);
    const read = await app.runtime.app.request(sandbox.origin + path, { headers });
    expect(await read.json()).toEqual({ data: first });
    const scan = (code: string) => app.post('/api/kiosk/checkin/qr', { code }, sandbox.origin,
      { authorization: `Bearer ${sandbox.kioskToken}` });
    const checked = await scan(first.code);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ data: { status: 'checked_in', member: { id: member.id } } });
    expect(await database.forGym(sandbox.gymId, tx => tx.select().from(attendances).where(and(eq(attendances.memberId, member.id), eq(attendances.sessionId, session.id)))))
      .toMatchObject([{ sessionId: session.id, source: 'kiosk' }]);
    const replacement = await app.post(path, { revision: first.revision }, sandbox.origin, { cookie: ownerCookie });
    const { data: second } = await replacement.json();
    expect(second.code).not.toBe(first.code);
    expect(await (await scan(first.code)).json()).toEqual({ data: { status: 'see_front_desk' } });
    const revoked = await app.runtime.app.request(sandbox.origin + path, { method: 'DELETE',
      headers: { ...headers, origin: sandbox.origin, 'content-type': 'application/json' }, body: JSON.stringify({ revision: second.revision }) });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ data: { code: null } });
    expect(await (await scan(second.code)).json()).toEqual({ data: { status: 'see_front_desk' } });
  } finally {
    await database.forGym(sandbox.gymId, async tx => {
      await tx.delete(attendances).where(eq(attendances.sessionId, session.id));
      await tx.delete(classBookings).where(eq(classBookings.sessionId, session.id));
      await tx.delete(classSessions).where(eq(classSessions.id, session.id));
    });
  }
});

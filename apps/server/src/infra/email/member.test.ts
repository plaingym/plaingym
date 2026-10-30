// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { members, uuidv7 } from '@plaingym/db';
import { eq } from 'drizzle-orm';
import { isInTransaction } from '@plaingym/shared/transaction';
import { useTestDatabase } from '../../../../../packages/db/src/testing/database.js';
import { createFactories } from '../../../../../packages/db/src/testing/factories.js';
import { FakeGymSettingsAccessor } from '../../core/interfaces/gym-settings.js';
import { FakeEmail, MemberEmail, SmtpEmail } from './index.js';
import { captureSmtp } from './test-smtp.js';

const database = useTestDatabase();
const factory = createFactories(database);
const gymA = uuidv7();
const gymB = uuidv7();
const memberA = uuidv7();
const memberB = uuidv7();
const settings = new FakeGymSettingsAccessor();
const log = vi.fn();
const message = { to: 'member@example.test', subject: 'Reminder', html: '<p>Reminder</p>', text: 'Reminder' };
let capture: Awaited<ReturnType<typeof captureSmtp>>;
let smtp: SmtpEmail;
function setEnabled(gymId: string, enabled: boolean) {
  settings.set({ gymId, timezone: 'UTC', currency: 'USD', billingEnabled: false, memberEmailsEnabled: enabled,
    websiteEnabled: false, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, revision: 1 });
}
function emailFor(gymId = gymA, memberId = memberA) {
  return new MemberEmail({ gymId, memberId, settings, email: smtp, forGym: database.forGym, logSuppression: log });
}
beforeAll(async () => {
  capture = await captureSmtp();
  smtp = new SmtpEmail({ host: '127.0.0.1', port: capture.port, security: 'plain', from: 'owner@example.test' });
  await factory('gyms', gymA);
  await factory('gyms', gymB);
  await factory('members', gymA, { id: memberA, email: message.to });
  await factory('members', gymB, { id: memberB, email: message.to });
  setEnabled(gymA, true);
  setEnabled(gymB, true);
});
afterAll(async () => { smtp?.close(); await capture?.close(); });

describe('member-targeted suppression', () => {
  it.each([
    { reason: 'disabled', enabled: false, optOut: false, deliverable: true },
    { reason: 'opt_out', enabled: true, optOut: true, deliverable: true },
    { reason: 'undeliverable', enabled: true, optOut: false, deliverable: false },
    { reason: 'disabled', enabled: false, optOut: true, deliverable: false },
    { reason: 'opt_out', enabled: true, optOut: true, deliverable: false },
  ])('suppresses $reason without any SMTP connection and logs only safe context', async ({ reason, enabled, optOut, deliverable }) => {
    setEnabled(gymA, enabled);
    await database.forGym(gymA, (tx) => tx.update(members).set({ emailOptOut: optOut, emailDeliverable: deliverable })
      .where(eq(members.id, memberA)));
    const before = capture.connections;
    const logsBefore = log.mock.calls.length;
    expect(await emailFor().sendEmail(message)).toEqual({ status: 'suppressed', reason });
    expect(capture.connections).toBe(before);
    expect(log.mock.calls).toHaveLength(logsBefore + 1);
    expect(log).toHaveBeenLastCalledWith({ event: 'email.suppressed', gymId: gymA, memberId: memberA, reason });
  });

  it('reloads changed switches and flags on the same instance, then sends outside the transaction', async () => {
    const delivered = new FakeEmail();
    const send = vi.spyOn(delivered, 'sendEmail').mockImplementation(async () => {
      expect(isInTransaction()).toBe(false);
      return { status: 'sent', messageId: 'mail_test' };
    });
    const bound = new MemberEmail({ gymId: gymA, memberId: memberA, settings, email: delivered,
      forGym: database.forGym, logSuppression: log });
    setEnabled(gymA, false);
    expect(await bound.sendEmail(message)).toEqual({ status: 'suppressed', reason: 'disabled' });
    setEnabled(gymA, true);
    await database.forGym(gymA, (tx) => tx.update(members).set({ emailOptOut: false, emailDeliverable: true })
      .where(eq(members.id, memberA)));
    expect(await bound.sendEmail(message)).toEqual({ status: 'sent', messageId: 'mail_test' });
    expect(send).toHaveBeenCalledTimes(1);
    await expect(emailFor().sendEmail(message)).resolves.toMatchObject({ status: 'sent' });
    expect(capture.messages.at(-1)).toContain('Reminder');
  });

  it('keeps gym switches independent, including concurrent requests', async () => {
    setEnabled(gymA, false);
    setEnabled(gymB, true);
    const before = capture.messages.length;
    const [a, b] = await Promise.all([emailFor().sendEmail(message), emailFor(gymB, memberB).sendEmail(message)]);
    expect(a).toEqual({ status: 'suppressed', reason: 'disabled' });
    expect(b).toMatchObject({ status: 'sent' });
    expect(capture.messages).toHaveLength(before + 1);
  });

  it('fails closed on cross-gym or missing members and mismatched recipients before SMTP', async () => {
    const before = capture.connections;
    await expect(emailFor(gymA, memberB).sendEmail(message)).rejects.toThrow('member not found');
    await expect(emailFor(gymB, memberA).sendEmail(message)).rejects.toThrow('member not found');
    await expect(emailFor(gymA, uuidv7()).sendEmail(message)).rejects.toThrow('member not found');
    await expect(emailFor().sendEmail({ ...message, to: 'someone-else@example.test' })).rejects.toThrow('does not match');
    await expect(emailFor().sendEmail({ ...message, to: message.to + ', someone-else@example.test' })).rejects.toThrow('does not match');
    expect(capture.connections).toBe(before);
  });

  it('fails closed if the member has no email or settings lookup fails', async () => {
    const missing = await factory('members', gymA, { email: null });
    const before = capture.connections;
    await expect(emailFor(gymA, missing.id).sendEmail(message)).rejects.toThrow('does not match');
    const unavailable = new MemberEmail({ gymId: gymA, memberId: memberA, email: smtp, forGym: database.forGym,
      settings: { get: async () => { throw new Error('Settings unavailable'); } } });
    // Every check runs before the transport, so its failure proves nothing was sent.
    await expect(unavailable.sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted', cause: { message: 'Settings unavailable' } });
    await expect(emailFor(gymA, missing.id).sendEmail(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
    expect(capture.connections).toBe(before);
  });

  it('rejects calls within forGym before attempting nested reads or SMTP', async () => {
    const before = capture.connections;
    await database.forGym(gymA, async () => {
      await expect(emailFor().sendEmail(message)).rejects.toThrow(/transaction/i);
    });
    expect(capture.connections).toBe(before);
  });

  it('keeps staff/security mail available while member notifications are disabled', async () => {
    setEnabled(gymA, false);
    await expect(smtp.sendEmail(message)).resolves.toMatchObject({ status: 'sent' });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, members, smsDailyUsage, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createGymSettingsAccessor } from '../../areas/settings/settings.js';
import type { SmsResolver } from '../../areas/settings/sms.js';
import { createSmsDeliveries, FakeSms, MemberSms, SmsDeliveryError, type MemberSmsOptions } from './index.js';

const db = useTestDatabase(), make = createFactories(db), scope = db.forGym;
const phone = '+12025550123', message = { to: phone, body: 'Private notice' };
async function fixture(options: { enabled?: boolean; cap?: number } = {}) {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T02:00:00Z');
  await make('gyms', gymId, { name: 'Test Gym', address: { country: 'US' }, timezone: 'America/Los_Angeles', memberSmsEnabled: options.enabled ?? true, smsDailyCap: options.cap ?? 1000 });
  const consent = { phone, phoneE164: phone, smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'portal' };
  const home = await make('households', gymId, consent), person = await make('members', gymId, { ...consent, householdId: home.id });
  const sms = new FakeSms(), logSuppression = vi.fn();
  const resolver: SmsResolver = { async resolve(id) { return { gymId: id, name: 'Test Gym', sms }; }, async configured() { return true; }, async status() { return { source: 'gym', unreadable: false }; } };
  const settings = createGymSettingsAccessor({ scope });
  const sender = (changes: Partial<MemberSmsOptions> = {}) => new MemberSms({ gymId, memberIds: [person.id], householdIds: [], kind: 'notices', resolver, settings, scope, clock, logSuppression, ...changes });
  const usage = () => scope(gymId, tx => tx.select().from(smsDailyUsage));
  return { gymId, clock, consent, home, person, sms, resolver, settings, sender, usage, logSuppression };
}
it('sends only after its transactions commit, with the gym name and a local-day slot', async () => {
  const f = await fixture();
  expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
  expect(f.sms.messages).toEqual([{ ...message, body: 'Test Gym: ' + message.body }]);
  expect(await f.usage()).toEqual([expect.objectContaining({ day: '2026-11-15', sent: 1, refused: 0 })]);
});
it('refuses a body too long once the gym name is added, before taking a cap slot', async () => {
  const f = await fixture();
  await expect(f.sender().sendSms({ to: phone, body: 'x'.repeat(1600) })).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.sms.messages).toEqual([]); expect(await f.usage()).toEqual([]);
});
it('suppresses disabled and unconfigured providers without taking a cap slot', async () => {
  const f = await fixture({ enabled: false });
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'disabled' });
  const on = await fixture();
  expect(await on.sender({ resolver: { ...on.resolver, async resolve() { return null; } } }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_provider' });
  expect(f.sms.messages).toEqual([]); expect(on.sms.messages).toEqual([]); expect(await on.usage()).toEqual([]);
  expect(f.logSuppression).toHaveBeenCalledWith({ event: 'sms.suppressed', gymId: f.gymId, memberIds: [f.person.id], reason: 'disabled' });
});
it('requires the right consent and refuses empty, missing and anonymized recipients', async () => {
  const f = await fixture();
  for (const changes of [{ kind: 'announcements' as const }, { memberIds: [] }, { memberIds: [uuidv7()] }])
    expect(await f.sender(changes).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await scope(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.person.id)));
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(f.sms.messages).toEqual([]);
});
it('allows announcements only with announcements consent', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.update(members).set({ smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'portal' }).where(eq(members.id, f.person.id)));
  expect(await f.sender({ kind: 'announcements' }).sendSms(message)).toMatchObject({ status: 'sent' });
});
it.each(['member', 'household'] as const)('refuses a changed %s phone even when stored consent remains', async kind => {
  const f = await fixture();
  if (kind === 'member') await scope(f.gymId, tx => tx.update(members).set({ phone: '+12025550125' }).where(eq(members.id, f.person.id)));
  else await scope(f.gymId, tx => tx.update(households).set({ phone: '+12025550125' }).where(eq(households.id, f.home.id)));
  expect(await f.sender(kind === 'household' ? { householdIds: [f.home.id] } : {}).sendSms(message)).toEqual({ status: 'suppressed', reason: 'phone_changed' });
  expect(f.sms.messages).toEqual([]);
});
it('requires the billing phone consent independently and never uses it for announcements', async () => {
  const f = await fixture();
  await scope(f.gymId, tx => tx.update(members).set({ phone: null, phoneE164: null, smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, f.person.id)));
  expect(await f.sender({ householdIds: [f.home.id] }).sendSms(message)).toMatchObject({ status: 'sent' });
  expect(await f.sender({ householdIds: [f.home.id], kind: 'announcements' }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await scope(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
  expect(await f.sender({ householdIds: [f.home.id] }).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(f.sms.messages).toHaveLength(1);
});
it('serializes concurrent cap reservations and counts every refused attempt', async () => {
  const f = await fixture({ cap: 2 });
  const results = await Promise.all(Array.from({ length: 6 }, () => f.sender().sendSms(message)));
  expect(results.filter(result => result.status === 'sent')).toHaveLength(2);
  expect(results.filter(result => result.status === 'suppressed')).toEqual(Array(4).fill({ status: 'suppressed', reason: 'cap_reached' }));
  expect(await f.usage()).toEqual([expect.objectContaining({ sent: 2, refused: 4 })]);
  f.clock.advance(24 * 60 * 60_000);
  expect(await f.sender().sendSms(message)).toMatchObject({ status: 'sent' });
  expect(await f.usage()).toHaveLength(2);
});
it('clears every consent at an opted-out number in this gym, auditing identifiers only', async () => {
  const f = await fixture(), other = await fixture();
  const second = await make('members', f.gymId, { ...f.consent, smsAnnouncementsConsentAt: f.clock.now(), smsAnnouncementsConsentSource: 'join' });
  const secondHome = await make('households', f.gymId, f.consent);
  f.sms.respondNext(new SmsDeliveryError('not_accepted', 'recipient_opted_out'));
  const deliveries = createSmsDeliveries({ scope, clock: f.clock }), key = 'notice:' + uuidv7();
  await expect(deliveries.send(f.gymId, key, f.sender(), message)).rejects.toMatchObject({ acceptance: 'not_accepted', reason: 'recipient_opted_out' });
  expect(await deliveries.state(f.gymId, key)).toBe('not_accepted');
  const rows = await scope(f.gymId, async tx => ({ people: await tx.select().from(members), homes: await tx.select().from(households), audits: await tx.select().from(auditEvents) }));
  for (const person of rows.people) expect(person).toMatchObject({ smsNoticesConsentAt: null, smsNoticesConsentSource: null, smsAnnouncementsConsentAt: null, smsAnnouncementsConsentSource: null });
  for (const home of rows.homes.filter(home => [f.home.id, secondHome.id].includes(home.id))) expect(home).toMatchObject({ smsNoticesConsentAt: null, smsNoticesConsentSource: null });
  expect(rows.audits.map(row => row.targetId)).toEqual(expect.arrayContaining([f.person.id, second.id, f.home.id, secondHome.id]));
  expect(rows.audits.every(row => JSON.stringify(row.after) === '{"source":"provider"}')).toBe(true);
  expect(JSON.stringify(rows.audits)).not.toContain(phone); expect(JSON.stringify(rows.audits)).not.toContain(message.body);
  expect(await f.sender().sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  expect(await other.sender().sendSms(message)).toMatchObject({ status: 'sent' });
});
it('refuses a foreign member, household, provider or settings projection', async () => {
  const f = await fixture(), other = await fixture();
  for (const changes of [{ memberIds: [other.person.id] }, { householdIds: [other.home.id] }])
    expect(await f.sender(changes).sendSms(message)).toEqual({ status: 'suppressed', reason: 'no_consent' });
  await expect(f.sender({ resolver: { ...other.resolver, async resolve() { return { gymId: other.gymId, name: 'Other', sms: other.sms }; } } }).sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  await expect(f.sender({ settings: { get: () => other.settings.get(other.gymId) } }).sendSms(message)).rejects.toMatchObject({ acceptance: 'not_accepted' });
  expect(f.sms.messages).toEqual([]); expect(other.sms.messages).toEqual([]);
});

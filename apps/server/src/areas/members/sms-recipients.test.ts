// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { households, members, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { householdNoticePhones, memberNoticePhones } from './sms-recipients.js';

const db = useTestDatabase(), make = createFactories(db), at = new Date('2026-11-16T12:00:00Z');
const consent = { smsNoticesConsentAt: at, smsNoticesConsentSource: 'portal' };
async function fixture() {
  const gymId = uuidv7(); await make('gyms', gymId);
  const home = await make('households', gymId, { email: ' PAYER@example.test ', phone: '+12025550123', phoneE164: '+12025550123', ...consent });
  const children = await Promise.all([1, 2, 3].map(() => make('members', gymId, { householdId: home.id })));
  return { gymId, home, children };
}
it('groups three children at their billing phone into one entry and does not repeat the household', async () => {
  const f = await fixture();
  const expected = [{ phoneE164: '+12025550123', memberIds: f.children.map(child => child.id).sort(), householdIds: [f.home.id], consentMemberIds: [], consentHouseholdIds: [f.home.id] }];
  expect(await db.forGym(f.gymId, tx => memberNoticePhones(tx, f.gymId, f.children.map(child => child.id)))).toEqual(expected);
  expect(await db.forGym(f.gymId, tx => householdNoticePhones(tx, f.gymId, [f.home.id, f.home.id]))).toEqual(expected);
});
it('prefers a member notice phone over the billing phone, and groups a shared number', async () => {
  const f = await fixture(), own = f.children[0]!;
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: '+12025550199', phoneE164: '+12025550199', ...consent }).where(eq(members.id, own.id)));
  const groups = await db.forGym(f.gymId, tx => memberNoticePhones(tx, f.gymId, f.children.map(child => child.id)));
  expect(groups).toHaveLength(2); expect(groups.find(group => group.phoneE164.endsWith('199'))?.memberIds).toEqual([own.id]);
  await db.forGym(f.gymId, tx => tx.update(members).set({ phone: '+12025550123', phoneE164: '+12025550123' }).where(eq(members.id, own.id)));
  const [shared] = await db.forGym(f.gymId, tx => memberNoticePhones(tx, f.gymId, f.children.map(child => child.id)));
  expect(shared?.memberIds).toEqual(f.children.map(child => child.id).sort()); expect(shared?.consentMemberIds).toEqual([own.id]);
});
it('prefers consent on the billing phone, else uses only consented members at its trimmed case-insensitive email', async () => {
  const f = await fixture(), child = f.children[0]!;
  await db.forGym(f.gymId, tx => tx.update(members).set({ email: 'payer@EXAMPLE.test', phone: '+12025550199', phoneE164: '+12025550199', ...consent }).where(eq(members.id, child.id)));
  expect((await db.forGym(f.gymId, tx => householdNoticePhones(tx, f.gymId, [f.home.id]))).map(group => group.phoneE164)).toEqual(['+12025550123']);
  await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
  const [group] = await db.forGym(f.gymId, tx => householdNoticePhones(tx, f.gymId, [f.home.id]));
  expect(group).toMatchObject({ phoneE164: '+12025550199', consentMemberIds: [child.id], consentHouseholdIds: [] });
  await db.forGym(f.gymId, tx => tx.update(members).set({ email: 'someone-else@example.test' }).where(eq(members.id, child.id)));
  expect(await db.forGym(f.gymId, tx => householdNoticePhones(tx, f.gymId, [f.home.id]))).toEqual([]);
});
it('never substitutes announcements consent, anonymized members, or another gym', async () => {
  const f = await fixture(), other = await fixture(), child = f.children[0]!;
  await db.forGym(f.gymId, async tx => {
    await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
    await tx.update(members).set({ email: 'payer@example.test', phone: '+12025550199', phoneE164: '+12025550199', smsAnnouncementsConsentAt: at, smsAnnouncementsConsentSource: 'portal' }).where(eq(members.id, child.id));
  });
  for (const select of [householdNoticePhones, memberNoticePhones]) {
    expect(await db.forGym(f.gymId, tx => select(tx, f.gymId, [f.home.id, child.id, other.home.id, other.children[0]!.id]))).toEqual([]);
    expect(await db.forGym(f.gymId, tx => select(tx, other.gymId, [other.home.id, other.children[0]!.id]))).toEqual([]);
    expect(await db.forGym(f.gymId, tx => select(tx, f.gymId, []))).toEqual([]);
  }
  await db.forGym(f.gymId, tx => tx.update(members).set({ ...consent, anonymizedAt: at }).where(eq(members.id, child.id)));
  expect(await db.forGym(f.gymId, tx => memberNoticePhones(tx, f.gymId, [child.id]))).toEqual([]);
});

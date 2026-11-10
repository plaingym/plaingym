// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { announcementOptOuts, auditEvents, members, signedLinks } from './schema/index.js';
import { uuidv7 } from './id.js';
import { createFactories } from './testing/factories.js';
import { useTestDatabase } from './testing/database.js';

const db = useTestDatabase(), factory = createFactories(db), now = new Date('2026-11-09T12:00:00Z');
async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7();
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const home = await factory('households', gymId);
  const member = await factory('members', gymId, { householdId: home.id, emailOptOut: true });
  const sibling = await factory('members', gymId, { householdId: home.id });
  const outsider = await factory('members', gymId), foreign = await factory('members', otherGym);
  const link = await factory('signedLinks', gymId, { householdId: home.id, memberId: member.id,
    purpose: 'unsubscribe', expiresAt: new Date('2027-01-01Z') });
  const scope = { kind: 'signed_link' as const, gymId, linkId: link.id, now };
  const rows = () => db.forGym(gymId, tx => tx.select().from(announcementOptOuts));
  return { gymId, otherGym, home, member, sibling, outsider, foreign, link, scope, rows };
}

it('grants only the stored member’s announcement preference and preserves siblings, other households and other gyms', async () => {
  const f = await fixture();
  for (const person of [f.sibling, f.outsider, f.foreign]) await factory('announcementOptOuts', person.gymId, { memberId: person.id });
  await db.forHousehold(f.scope, async q => {
    expect(await q.announcementPreference()).toEqual({ member: { firstName: f.member.firstName, lastName: f.member.lastName }, optedOut: false });
    for (const read of [q.members, () => q.member(f.member.id), () => q.member(f.sibling.id), () => q.member(f.outsider.id),
      () => q.member(f.foreign.id), q.household, q.invoices, q.paymentMethods, q.waivers, q.waiverTemplates,
      q.bookings, q.attendance, q.ranks, q.memberships]) await expect(read()).rejects.toThrow();
    expect(q).not.toHaveProperty('execute');
    expect(q).not.toHaveProperty('transaction');
  });
  const anotherLink = await factory('signedLinks', f.gymId, { householdId: f.home.id, memberId: f.member.id,
    purpose: 'unsubscribe', expiresAt: new Date('2027-01-01Z') });
  await Promise.all([f.scope, { ...f.scope, linkId: anotherLink.id }].map(scope =>
    db.forHousehold(scope, q => q.setAnnouncementOptOut(true, () => now))));
  expect((await f.rows()).map(row => row.memberId).sort()).toEqual([f.member.id, f.sibling.id, f.outsider.id].sort());
  await db.forHousehold(f.scope, async q => {
    expect((await q.announcementPreference()).optedOut).toBe(true);
    await q.setAnnouncementOptOut(false, () => now);
    await q.setAnnouncementOptOut(false, () => now);
  });
  expect((await f.rows()).map(row => row.memberId).sort()).toEqual([f.sibling.id, f.outsider.id].sort());
  expect(await db.forGym(f.otherGym, tx => tx.select().from(announcementOptOuts))).toHaveLength(1);
  const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.member.id)));
  expect(audits.map(row => row.action).sort()).toEqual(['announcement.unsubscribed', 'announcement.resubscribed'].sort());
  expect(audits.every(row => row.occurredAt.getTime() === now.getTime())).toBe(true);
  expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0]!.emailOptOut).toBe(true);
});

it.each(['unknown', 'cross-gym', 'expired', 'revoked', 'used', 'wrong-purpose', 'anonymized'])(
  'refuses %s links for both preference reads and writes', async invalid => {
    const f = await fixture();
    if (invalid === 'unknown') f.scope.linkId = uuidv7();
    else if (invalid === 'cross-gym') f.scope.gymId = f.otherGym;
    else await db.forGym(f.gymId, async tx => {
      if (invalid === 'anonymized') await tx.update(members).set({ anonymizedAt: now }).where(eq(members.id, f.member.id));
      else await tx.update(signedLinks).set(invalid === 'expired' ? { expiresAt: now }
        : invalid === 'revoked' ? { revokedAt: now } : invalid === 'used' ? { usedAt: now }
          : { purpose: 'sign_waiver' }).where(eq(signedLinks.id, f.link.id));
    });
    for (const write of [false, true]) await expect(db.forHousehold(f.scope, q => write
      ? q.setAnnouncementOptOut(true, () => now) : q.announcementPreference())).rejects.toMatchObject({ code: 'household_access_denied' });
    expect(await f.rows()).toEqual([]);
  });

it('the database rejects cross-household links and member moves while a link references that household', async () => {
  const f = await fixture();
  await expect(db.forGym(f.gymId, tx => tx.update(signedLinks).set({ memberId: f.outsider.id }).where(eq(signedLinks.id, f.link.id))))
    .rejects.toMatchObject({ cause: { code: '23503' } });
  await expect(db.forGym(f.gymId, tx => tx.update(members).set({ householdId: f.outsider.householdId }).where(eq(members.id, f.member.id))))
    .rejects.toMatchObject({ cause: { code: '23503' } });
  expect(await f.rows()).toEqual([]);
});

it('rechecks revocation, resource binding and expiry after resolving a grant, and rolls preference writes and audits back together', async () => {
  for (const change of ['revoked', 'moved', 'expired'] as const) {
    const f = await fixture();
    let grantReady!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => { grantReady = resolve; }), proceed = new Promise<void>(resolve => { resume = resolve; });
    const write = db.forHousehold(f.scope, async q => {
      grantReady(); await proceed;
      return q.setAnnouncementOptOut(true, () => change === 'expired' ? f.link.expiresAt : now);
    });
    const refused = expect(write).rejects.toMatchObject({ code: 'household_access_denied' });
    await ready;
    await db.forGym(f.gymId, async tx => {
      if (change === 'revoked') await tx.update(signedLinks).set({ revokedAt: now }).where(eq(signedLinks.id, f.link.id));
      if (change === 'moved') await tx.update(signedLinks).set({ memberId: f.outsider.id, householdId: f.outsider.householdId })
        .where(eq(signedLinks.id, f.link.id));
    });
    resume(); await refused;
    expect(await f.rows()).toEqual([]);
  }
  const f = await fixture();
  await expect(db.forHousehold(f.scope, async q => {
    await q.setAnnouncementOptOut(true, () => now); throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await f.rows()).toEqual([]);
  expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(and(
    eq(auditEvents.targetId, f.member.id), eq(auditEvents.action, 'announcement.unsubscribed'))))).toEqual([]);
});

it('refuses preference mutations from logged-in users and every other signed-link purpose', async () => {
  const f = await fixture(), user = await factory('authUser', f.gymId);
  await factory('householdUsers', f.gymId, { householdId: f.home.id, userId: user.id, scope: 'payer' });
  const invoice = await factory('invoices', f.gymId, { householdId: f.home.id });
  for (const purpose of ['pay_invoice', 'update_card', 'sign_waiver', 'onboarding']) {
    const link = await factory('signedLinks', f.gymId, { purpose, householdId: f.home.id, expiresAt: f.link.expiresAt,
      invoiceId: purpose === 'pay_invoice' ? invoice.id : null, memberId: purpose === 'sign_waiver' ? f.member.id : null });
    await db.forHousehold({ ...f.scope, linkId: link.id }, async q => {
      await expect(q.announcementPreference()).rejects.toThrow();
      await expect(q.setAnnouncementOptOut(true, () => now)).rejects.toThrow();
    });
  }
  await db.forHousehold({ kind: 'user', gymId: f.gymId, householdId: f.home.id, userId: user.id }, async q => {
    await expect(q.announcementPreference()).rejects.toThrow();
    await expect(q.setAnnouncementOptOut(true, () => now)).rejects.toThrow();
  });
  expect(await f.rows()).toEqual([]);
});

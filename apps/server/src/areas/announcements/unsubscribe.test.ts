// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { announcementOptOuts, auditEvents, signedLinks, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { TestClock } from '../../core/clock.js';
import { createSignedLinksService } from '../links/service.js';
import { deliverSignedLink } from '../links/service.delivery.js';
import { createTranslator } from '@plaingym/shared';
import { renderSignedLink } from '../../emails/links/service.js';
import { createCampaignsService } from '../links/campaigns.js';
import { deliverCampaignLink } from '../links/campaigns.delivery.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createAnnouncementUnsubscribeService, issueUnsubscribeLink } from './unsubscribe.js';

const db = useTestDatabase(), factory = createFactories(db);
it('mints a hashed one-member, 90-day credential inside its caller’s transaction and keeps it reusable', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-09T12:00:00Z'); await factory('gyms', gymId);
  const member = await factory('members', gymId);
  const token = await db.forGym(gymId, tx => issueUnsubscribeLink(tx, gymId, member.id, clock.now()));
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const result = await links.resolve(gymId, token); expect(result.status).toBe('active');
  if (result.status !== 'active') throw new Error('Expected active link');
  const [row] = await db.forGym(gymId, tx => tx.select().from(signedLinks));
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(row).toMatchObject({ purpose: 'unsubscribe', memberId: member.id, householdId: member.householdId,
    createdBy: null, invoiceId: null, campaignId: null, tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date('2027-02-07T12:00:00Z') });
  expect(result.principal.link).toEqual({ purpose: 'unsubscribe', memberId: member.id });
  const service = createAnnouncementUnsubscribeService({ scope: db.forHousehold });
  await service.set(gymId, row!.id, true, clock); await service.set(gymId, row!.id, true, clock);
  expect((await service.read(gymId, row!.id, clock)).optedOut).toBe(true);
  expect((await links.resolve(gymId, token)).status).toBe('active');
  await service.set(gymId, row!.id, false, clock);
  expect(await db.forGym(gymId, tx => tx.select().from(announcementOptOuts))).toEqual([]);
  const audits = await db.forGym(gymId, tx => tx.select().from(auditEvents));
  expect(audits.map(a => a.action).sort()).toEqual(['signed_link.created', 'announcement.unsubscribed', 'announcement.resubscribed'].sort());
  expect(JSON.stringify(audits)).not.toContain(token); expect(JSON.stringify(audits)).not.toContain(row!.tokenHash);
});

it('rolls minting and its audit back with a failed send reservation and refuses other gyms or erased members', async () => {
  const gymId = uuidv7(), foreignGym = uuidv7(), now = new Date('2026-11-09T12:00:00Z');
  await factory('gyms', gymId); await factory('gyms', foreignGym);
  const member = await factory('members', gymId), foreign = await factory('members', foreignGym);
  const erased = await factory('members', gymId, { anonymizedAt: now });
  await expect(db.forGym(gymId, async tx => { await issueUnsubscribeLink(tx, gymId, member.id, now); throw new Error('reservation failed'); })).rejects.toThrow('reservation failed');
  for (const id of [foreign.id, erased.id, uuidv7()])
    await expect(db.forGym(gymId, tx => issueUnsubscribeLink(tx, gymId, id, now))).rejects.toMatchObject({ code: 'not_found' });
  expect(await db.forGym(gymId, tx => tx.select().from(signedLinks))).toEqual([]);
  expect(await db.forGym(gymId, tx => tx.select().from(auditEvents))).toEqual([]);
});

it('hides unsubscribe links from staff lists, lookups, revocation, consumption and sending', async () => {
  const gymId = uuidv7(), clock = new TestClock('2026-11-09T12:00:00Z'); await factory('gyms', gymId);
  const member = await factory('members', gymId);
  const token = await db.forGym(gymId, tx => issueUnsubscribeLink(tx, gymId, member.id, clock.now()));
  const [row] = await db.forGym(gymId, tx => tx.select().from(signedLinks));
  const links = createSignedLinksService({ scope: db.forGym, clock }), context = { gymId, actor: { kind: 'system' as const } };
  await links.create(context, { purpose: 'update_card', householdId: member.householdId, expiresAt: row!.expiresAt.toISOString() });
  const listed = await links.list(gymId, { householdId: member.householdId });
  expect(listed.pagination.total).toBe(1); expect(listed.data.map(l => l.purpose)).toEqual(['update_card']);
  await expect(links.get(gymId, row!.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(links.revoke(context, row!.id)).rejects.toMatchObject({ code: 'not_found' });
  await expect(links.markUsed({ gymId, linkId: row!.id })).rejects.toMatchObject({ code: 'not_found' });
  // The staff send command has no existing-token resend path; its schema refuses the purpose.
  await expect(links.create(context, { purpose: 'unsubscribe', memberId: member.id, householdId: member.householdId,
    expiresAt: row!.expiresAt.toISOString() } as never)).rejects.toThrow();
  const sendEmail = vi.fn(), delivery = { gymId, origin: 'https://gym.example.test', gymName: 'Example',
    memberEmailsEnabled: true, t: createTranslator({}), email: { sendEmail } };
  const sending = createSignedLinksService({ scope: db.forGym, clock, delivery: { prepare: async () => delivery } });
  await expect(sending.send(context, { purpose: 'unsubscribe', memberId: member.id, householdId: member.householdId,
    expiresAt: row!.expiresAt.toISOString(), sendGeneration: uuidv7() } as never)).rejects.toThrow();
  await expect(deliverSignedLink({ scope: db.forGym, context, token, delivery, link: { ...row!, purpose: 'unsubscribe',
    memberId: member.id, invoiceId: null, createdAt: row!.createdAt.toISOString(), expiresAt: row!.expiresAt.toISOString(),
    usedAt: null, revokedAt: null } })).rejects.toMatchObject({ code: 'not_found' });
  expect(() => renderSignedLink({ purpose: 'unsubscribe', gymName: 'Example', url: '/l/' + token } as never, delivery.t)).toThrow();
  expect(sendEmail).not.toHaveBeenCalled();
  // Even a mistakenly attached campaign cannot list, rotate or resend this credential.
  const campaign = await factory('linkCampaigns', gymId, { purpose: 'update_card', createdAt: clock.now(), reminderSchedule: [] });
  await db.forGym(gymId, tx => tx.update(signedLinks).set({ campaignId: campaign.id }).where(eq(signedLinks.id, row!.id)));
  const prepare = vi.fn(async () => delivery), jobs = new FakeJobs(clock);
  const campaigns = createCampaignsService({ scope: db.forGym, clock, jobs, delivery: { prepare },
    paymentsFor: async () => new FakePayments(gymId, clock) });
  expect((await campaigns.get(gymId, campaign.id)).progress.total).toBe(0);
  expect(await campaigns.recipients(gymId, campaign.id)).toMatchObject({ data: [], pagination: { total: 0 } });
  await campaigns.publish({ campaignId: campaign.id }, gymId);
  await campaigns.send({ campaignId: campaign.id, linkId: row!.id, occurrence: 'initial' }, gymId);
  await deliverCampaignLink({ scope: db.forGym, clock, delivery: { prepare } }, gymId, campaign.id, row!.id, 'initial');
  expect(prepare).not.toHaveBeenCalled();
  expect(sendEmail).not.toHaveBeenCalled();
  expect((await links.resolve(gymId, token)).status).toBe('active');
  expect((await db.forGym(gymId, tx => tx.select().from(signedLinks).where(eq(signedLinks.id, row!.id))))[0]!.revokedAt).toBeNull();
});

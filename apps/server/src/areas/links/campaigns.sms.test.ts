// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, households, members, signedLinks, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { DeliveryError, FakeEmail } from '../../infra/email/index.js';
import { FakeSms, createSmsPhoneDigest } from '../../infra/sms/index.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakePayments } from '../../infra/payments/index.js';
import { createGoLiveService } from '../settings/go-live.js';
import { createCampaignsService, campaignSendJob } from './campaigns.js';
import { createCampaignJobs } from './campaigns.jobs.js';
import { deliverCampaignLink } from './campaigns.delivery.js';
import { credentialDisclosed, deliveryHistory } from './campaigns.attempts.js';
import { createSignedLinksService } from './service.js';

const db = useTestDatabase(), make = createFactories(db), t = createTranslator(locales.en ?? {});
async function fixture(emailEnabled = true, purpose: 'update_card' | 'onboarding' = 'update_card') {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T12:00:00Z');
  await make('gyms', gymId, { memberSmsEnabled: true, memberEmailsEnabled: emailEnabled });
  const home = await make('households', gymId, { email: 'payer@example.test', phone: '+12025550123', phoneE164: '+12025550123',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const person = await make('members', gymId, { householdId: home.id, email: home.email, phone: '+12025550124', phoneE164: '+12025550124',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const jobs = new FakeJobs(clock), email = new FakeEmail(), sms = new FakeSms(), payments = new FakePayments(gymId, clock);
  const resolver = { resolve: async () => ({ gymId, name: 'Gym', sms }), configured: async () => true,
    status: async () => ({ source: 'gym' as const, unreadable: false }) };
  const prepareEmail = vi.fn(async () => ({ gymId, origin: 'https://gym.example.test', gymName: 'Gym', email, t, memberEmailsEnabled: emailEnabled }));
  const prepareSms = vi.fn(async () => ({ gymId, origin: 'https://gym.example.test', t, resolver }));
  const service = createCampaignsService({ scope: db.forGym, clock, jobs, paymentsFor: async () => payments,
    delivery: { prepare: prepareEmail }, smsDelivery: { prepare: prepareSms },
    smsPhoneDigest: createSmsPhoneDigest('campaign-test-secret') });
  createServerRegistry({ jobs: createCampaignJobs(() => service) }).registerJobs(jobs, new Set());
  const context = { gymId, actor: { kind: 'system' as const } };
  const campaign = await service.create(context, { purpose, name: 'Collect cards', expiresAt: '2026-12-01T12:00:00Z',
    reminderSchedule: [3], recipients: [{ householdId: home.id }] });
  const link = (await service.recipients(gymId, campaign.campaign.id)).data[0]!.link;
  const work = { campaignId: campaign.campaign.id, linkId: link.id, occurrence: 'initial' };
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const drain = async () => { for (let n = 0; n < 20 && await jobs.runNext(); n++); };
  const smsToken = () => /\/l\/([\w-]+)/.exec(sms.messages.at(-1)!.body)![1]!;
  const audits = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, link.id)));
  const disclosed = () => db.forGym(gymId, async tx => credentialDisclosed(await deliveryHistory(tx, gymId, [link.id]), link.id));
  const goLive = createGoLiveService({ scope: db.forGym, clock, smtpConfigured: async () => true });
  async function emailSwitch(enabled: boolean) {
    await goLive.update(context, { revision: (await goLive.checklist(gymId)).revision, memberEmailsEnabled: enabled });
    emailEnabled = enabled;
  }
  return { gymId, clock, home, person, service, campaign, context, work, links, link, email, sms, drain, smsToken, resolver,
    prepareEmail, prepareSms, jobs, audits, disclosed, emailSwitch };
}

describe('card campaigns by text', () => {
  it('texts the emailed credential once per household and occurrence and tracks completion on that same row', async () => {
    const f = await fixture();
    await f.drain();
    await f.service.send(f.work, f.gymId);
    expect(f.sms.messages).toHaveLength(1);
    expect(f.email.messages).toHaveLength(1);
    expect(f.email.messages[0]!.text).toContain('/l/' + f.smsToken());
    expect(f.sms.messages[0]!.to).toBe(f.home.phoneE164);
    expect((await f.service.recipients(f.gymId, f.campaign.campaign.id)).data[0]).toMatchObject({ smsState: 'sent' });
    expect(await db.forGym(f.gymId, tx => tx.select().from(signedLinks))).toHaveLength(1);
    f.clock.advance(3 * 86400_000);
    await f.service.scan(f.gymId); await f.drain();
    expect(f.sms.messages).toHaveLength(2);
    expect(await f.links.resolve(f.gymId, f.smsToken())).toMatchObject({ status: 'active' });
    await f.links.markUsed({ gymId: f.gymId, linkId: f.link.id });
    expect((await f.service.get(f.gymId, f.campaign.campaign.id)).progress.completed).toBe(1);
    f.clock.advance(86400_000);
    await f.service.remindCampaign(f.context, f.campaign.campaign.id); await f.drain();
    expect(f.sms.messages).toHaveLength(2);
  });
  it('texts without preparing SMTP when member emails are switched off', async () => {
    const f = await fixture(false);
    f.prepareEmail.mockRejectedValue(new Error('SMTP is not configured'));
    await f.drain();
    expect(f.prepareEmail).not.toHaveBeenCalled();
    expect(f.email.messages).toHaveLength(0);
    expect(f.sms.messages).toHaveLength(1);
    expect(await f.links.resolve(f.gymId, f.smsToken())).toMatchObject({ status: 'active' });
  });
  it('falls back to consented members, deduplicates their phone and skips nonconsenting members', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    await make('members', f.gymId, { householdId: f.home.id, email: f.home.email, phone: f.person.phone, phoneE164: f.person.phoneE164,
      smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' });
    await make('members', f.gymId, { householdId: f.home.id, email: f.home.email, phone: '+12025550125', phoneE164: '+12025550125' });
    await f.drain();
    expect(f.sms.messages).toHaveLength(1);
    expect(f.sms.messages[0]!.to).toBe(f.person.phoneE164);
  });
  it('keeps a possibly delivered text usable and never resends that occurrence', async () => {
    const f = await fixture(false);
    const send = f.sms.sendSms.bind(f.sms);
    f.sms.sendSms = async message => { await send(message); throw new DeliveryError('unknown', 'Reply lost'); };
    await f.drain();
    expect((await f.service.recipients(f.gymId, f.campaign.campaign.id)).data[0]).toMatchObject({ smsState: 'unknown' });
    expect(await f.links.resolve(f.gymId, f.smsToken())).toMatchObject({ status: 'active' });
    await f.service.send(f.work, f.gymId);
    expect(f.sms.messages).toHaveLength(1);
  });
  it.each([true, false])('retries email preparation with texts enabled (consented phones: %s)', async consented => {
    const f = await fixture();
    if (!consented) await db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
      await tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, f.person.id));
    });
    f.prepareEmail.mockRejectedValueOnce(new Error('SMTP is not configured'));
    await f.drain();
    expect(f.email.messages).toHaveLength(0); expect(f.sms.messages).toHaveLength(0);
    expect((await f.audits()).some(a => a.action === 'link_campaign.delivery_reserved')).toBe(false);
    expect(await f.disclosed()).toBe(false);
    const [retry] = f.jobs.jobs.filter(j => j.name === campaignSendJob);
    expect(retry).toMatchObject({ status: 'queued', attempt: 1 });
    f.clock.set(retry!.runAt); await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(consented ? 1 : 0);
    expect(f.jobs.jobs.find(j => j.id === retry!.id)).toMatchObject({ status: 'completed' });
  });
  it.each(['throws', 'invalid_origin'] as const)('delivers email when text preparation %s', async reason => {
    const f = await fixture();
    if (reason === 'throws') f.prepareSms.mockRejectedValue(new Error('SMS configuration unavailable'));
    else f.prepareSms.mockResolvedValue({ ...await f.prepareSms(), origin: 'https://gym.example.test/unsafe/path' });
    await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(0);
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toMatchObject([{ status: 'completed', attempt: 1 }]);
    expect((await f.audits()).some(a => a.action === 'link_campaign.sms_prepare_failed')).toBe(true);
    await f.service.send(f.work, f.gymId); expect(f.email.messages).toHaveLength(1);
  });
  it('retries text preparation when email is switched off', async () => {
    const f = await fixture(false);
    f.prepareSms.mockRejectedValueOnce(new Error('SMS configuration unavailable'));
    await f.drain();
    expect(await f.disclosed()).toBe(false);
    const [retry] = f.jobs.jobs.filter(j => j.name === campaignSendJob);
    expect(retry).toMatchObject({ status: 'queued', attempt: 1 });
    f.clock.set(retry!.runAt); await f.drain();
    expect(f.sms.messages).toHaveLength(1); expect(f.email.messages).toHaveLength(0);
  });
  it.each(['initial', 'reminder'] as const)('releases a refused text-only %s and retries without losing the previous credential', async when => {
    const f = await fixture(false);
    let oldToken: string | undefined;
    if (when === 'reminder') {
      await f.drain(); oldToken = f.smsToken(); f.clock.advance(86400_000);
      await f.service.remindCampaign(f.context, f.campaign.campaign.id);
    }
    const send = vi.spyOn(f.sms, 'sendSms').mockRejectedValueOnce(new DeliveryError('not_accepted', 'Provider refused'));
    await f.drain();
    const records = await f.audits(), released = records.find(a => a.action === 'link_campaign.delivery_released')!;
    expect(records.some(a => a.action === 'link_campaign.delivery_not_accepted')).toBe(true);
    expect(records.filter(a => a.action === 'link_campaign.delivery_reserved').some(a =>
      (a.after as { reservation: string }).reservation === (released.after as { reservation: string }).reservation)).toBe(true);
    if (oldToken) expect(await f.links.resolve(f.gymId, oldToken)).toMatchObject({ status: 'active' });
    else expect(await f.disclosed()).toBe(false);
    const [retry] = f.jobs.jobs.filter(j => j.name === campaignSendJob && j.status === 'queued');
    expect(retry).toMatchObject({ attempt: 1 });
    f.clock.set(retry!.runAt); await f.drain();
    expect(f.sms.messages).toHaveLength(when === 'reminder' ? 2 : 1);
    expect(await f.links.resolve(f.gymId, f.smsToken())).toMatchObject({ status: 'active' });
    if (oldToken) expect((await f.links.resolve(f.gymId, oldToken)).status).not.toBe('active');
    await f.service.send(retry!.payload, f.gymId); expect(send).toHaveBeenCalledTimes(2);
  });
  it.each(['no_phones', 'consent_withdrawn', 'switch_off'] as const)('records text-only suppression without disclosure or job retries for %s', async reason => {
    const f = await fixture(false);
    const withdraw = () => db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id));
      await tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, f.person.id));
    });
    if (reason === 'no_phones') await withdraw();
    else if (reason === 'consent_withdrawn') f.resolver.resolve = async () => { await withdraw(); return { gymId: f.gymId, name: 'Gym', sms: f.sms }; };
    else {
      const goLive = createGoLiveService({ scope: db.forGym, clock: f.clock, smtpConfigured: async () => true });
      f.resolver.resolve = async () => {
        await goLive.update(f.context, { revision: (await goLive.checklist(f.gymId)).revision, memberSmsEnabled: false });
        return { gymId: f.gymId, name: 'Gym', sms: f.sms };
      };
    }
    await f.drain();
    expect(f.sms.messages).toHaveLength(0); expect(await f.disclosed()).toBe(false);
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toMatchObject([{ status: 'completed', attempt: 1 }]);
    expect((await f.audits()).some(a => a.action === 'link_campaign.delivery_suppressed')).toBe(true);
    expect((await f.audits()).some(a => a.action === 'link_campaign.delivery_not_accepted')).toBe(false);
    await f.service.send(f.work, f.gymId);
    expect((await f.audits()).filter(a => a.action === 'link_campaign.delivery_reserved')).toHaveLength(1);
  });
  it('never releases or retries a refused text after email delivered the credential', async () => {
    const f = await fixture();
    const send = vi.spyOn(f.sms, 'sendSms').mockRejectedValue(new DeliveryError('not_accepted', 'Provider refused'));
    await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(await f.disclosed()).toBe(true);
    expect((await f.audits()).some(a => a.action === 'link_campaign.delivery_released')).toBe(false);
    await f.service.send(f.work, f.gymId); expect(send).toHaveBeenCalledTimes(1);
  });
  it('leaves onboarding unpublished with emails off and catches up when email is enabled', async () => {
    const f = await fixture(false, 'onboarding');
    await f.drain(); await f.service.scan(f.gymId);
    expect(await f.service.remindCampaign(f.context, f.campaign.campaign.id)).toEqual({ queued: 0 });
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toHaveLength(0);
    expect((await f.audits()).some(a => a.action === 'link_campaign.delivery_queued')).toBe(false);
    await f.service.send(f.work, f.gymId);
    expect(f.prepareEmail).not.toHaveBeenCalled(); expect(f.prepareSms).not.toHaveBeenCalled();
    await f.emailSwitch(true); await f.service.scan(f.gymId); await f.drain();
    expect(f.email.messages).toHaveLength(1); expect(f.sms.messages).toHaveLength(0);
    expect(f.jobs.jobs.filter(j => j.name === campaignSendJob)).toMatchObject([{ status: 'completed' }]);
  });
  it('records a skip when email is switched off after the send check and no text applies', async () => {
    const f = await fixture(false, 'onboarding');
    await deliverCampaignLink({ scope: db.forGym, clock: f.clock, delivery: { prepare: f.prepareEmail }, smsDelivery: { prepare: f.prepareSms },
      smsPhoneDigest: createSmsPhoneDigest('campaign-test-secret') }, f.gymId, f.work.campaignId, f.work.linkId, f.work.occurrence);
    expect(f.prepareEmail).not.toHaveBeenCalled(); expect(f.prepareSms).not.toHaveBeenCalled();
    const actions = (await f.audits()).map(a => a.action);
    expect(actions).toContain('link_campaign.delivery_skipped');
    expect(actions).not.toContain('link_campaign.delivery_reserved');
  });
  it('does not text erased, nonconsenting, or invalid recipients, or another gym', async () => {
    const f = await fixture(), other = await fixture();
    await db.forGym(f.gymId, async tx => {
      await tx.update(households).set({ phone: 'invalid' }).where(eq(households.id, f.home.id));
      await tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.person.id));
    });
    await f.service.send(f.work, other.gymId);
    await f.drain();
    expect(f.sms.messages).toHaveLength(0);
    expect(other.sms.messages).toHaveLength(0);
  });
  it('refuses a fallback member who moves out of the household during provider preparation', async () => {
    const f = await fixture(), other = await make('households', f.gymId);
    await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    f.resolver.resolve = async () => {
      await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: other.id }).where(eq(members.id, f.person.id)));
      return { gymId: f.gymId, name: 'Gym', sms: f.sms };
    };
    await f.drain();
    expect(f.sms.messages).toHaveLength(0);
    expect((await f.service.recipients(f.gymId, f.campaign.campaign.id)).data[0]).toMatchObject({ smsState: 'not_accepted' });
  });
});

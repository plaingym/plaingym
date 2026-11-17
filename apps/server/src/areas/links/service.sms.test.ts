// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { households, invoices, members, signedLinks, smsDeliveries, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { AppError, createTranslator, errorResponse, type StaffRole } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { TestClock } from '../../core/clock.js';
import type { RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { authorize } from '../staff/auth.permissions.js';
import { DeliveryError, FakeSms } from '../../infra/sms/index.js';
import { smsInFlightMs } from '../../infra/sms/deliveries.js';
import { createSignedLinksService } from './service.js';
import { createSignedLinksRoutes } from './service.routes.js';

const db = useTestDatabase(), make = createFactories(db), t = createTranslator(locales.en ?? {});
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-11-16T12:00:00Z'), sms = new FakeSms();
  await make('gyms', gymId, { memberSmsEnabled: true, memberEmailsEnabled: false });
  const home = await make('households', gymId, { phone: '+12025550123', phoneE164: '+12025550123',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const member = await make('members', gymId, { householdId: home.id, phone: '+12025550124', phoneE164: '+12025550124',
    smsNoticesConsentAt: clock.now(), smsNoticesConsentSource: 'staff' });
  const invoice = await make('invoices', gymId, { householdId: home.id, status: 'open', number: 1, amountCents: 1000 });
  const user = await make('authUser', gymId);
  const resolver = { resolve: async () => ({ gymId, name: 'Gym', sms }), configured: async () => true,
    status: async () => ({ source: 'gym' as const, unreadable: false }) };
  const smsDelivery = { prepare: async () => ({ gymId, origin: 'https://gym.example.test', resolver, t }) };
  const links = createSignedLinksService({ scope: db.forGym, clock, smsDelivery });
  const context = { gymId, actor: { kind: 'system' as const } };
  const request = (generation = uuidv7()) => ({ channel: 'sms' as const, purpose: 'update_card' as const,
    householdId: home.id, expiresAt: '2026-11-20T12:00:00Z', sendGeneration: generation });
  const rows = () => db.forGym(gymId, tx => tx.select().from(signedLinks));
  const token = () => /\/l\/([\w-]+)/.exec(sms.messages.at(-1)!.body)![1]!;
  function app(role: StaffRole) {
    const app = new OpenAPIHono<RequestEnvironment>();
    app.use('*', async (c, next) => {
      c.set('context', { requestId: 'sms-link', gym: { gymId, timezone: 'UTC', enabledModules: new Set() },
        principal: { kind: 'staff', gymId, userId: user.id, roles: [role] }, clock });
      await next();
    });
    app.onError((error, c) => c.json(errorResponse(error, 'sms-link'), error instanceof AppError ? error.status : 500));
    createServerRegistry({ routes: createSignedLinksRoutes(links) }).mount(app, authorize, new Set());
    return app;
  }
  return { gymId, clock, sms, home, member, invoice, links, context, request, rows, token, app, resolver };
}

describe('signed links by text', () => {
  it.each(['onboarding', 'pay_invoice', 'update_card', 'sign_waiver'] as const)('%s shares expiry, isolation and single-use behavior', async purpose => {
    const f = await fixture();
    const request = { ...f.request(), purpose, recipientMemberId: f.member.id };
    const sent = await f.links.send(f.context, purpose === 'pay_invoice' ? { ...request, purpose, invoiceId: f.invoice.id }
      : purpose === 'sign_waiver' ? { ...request, purpose, memberId: f.member.id } : { ...request, purpose });
    expect(f.sms.messages).toHaveLength(1);
    expect(f.sms.messages[0]!.to).toBe(f.member.phoneE164);
    expect(sent.expiresAt).toBe('2026-11-20T12:00:00.000Z');
    const token = f.token();
    expect(await f.links.resolve(f.gymId, token)).toMatchObject({ status: 'active', principal: { householdId: f.home.id } });
    const other = await fixture();
    expect(await f.links.resolve(other.gymId, token)).toEqual({ status: 'not_found' });
    await f.links.markUsed({ gymId: f.gymId, linkId: sent.id });
    expect(await f.links.resolve(f.gymId, token)).toEqual({ status: 'used' });
    await expect(f.links.markUsed({ gymId: f.gymId, linkId: sent.id })).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['household', 'member'] as const)('refuses a %s without consent before creating a link', async target => {
    const f = await fixture();
    if (target === 'household') await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    else await db.forGym(f.gymId, tx => tx.update(members).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(members.id, f.member.id)));
    await expect(f.links.send(f.context, { ...f.request(), ...(target === 'member' ? { recipientMemberId: f.member.id } : {}) }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(await f.rows()).toHaveLength(0);
    expect(f.sms.messages).toHaveLength(0);
  });
  it.each(['foreign_household', 'foreign_gym', 'erased', 'invalid_phone'] as const)('refuses %s before minting', async reason => {
    const f = await fixture();
    let recipientMemberId = f.member.id;
    if (reason === 'foreign_household') recipientMemberId = (await make('members', f.gymId)).id;
    if (reason === 'foreign_gym') recipientMemberId = (await fixture()).member.id;
    if (reason === 'erased') await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.member.id)));
    if (reason === 'invalid_phone') await db.forGym(f.gymId, tx => tx.update(members).set({ phone: 'invalid' }).where(eq(members.id, f.member.id)));
    await expect(f.links.send(f.context, { ...f.request(), recipientMemberId })).rejects.toMatchObject({ code: reason === 'invalid_phone' ? 'invalid_request' : 'not_found' });
    expect(await f.rows()).toHaveLength(0);
    expect(f.sms.messages).toHaveLength(0);
  });
  it('refuses an invalid billing phone before minting', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(households).set({ phone: 'invalid' }).where(eq(households.id, f.home.id)));
    await expect(f.links.send(f.context, f.request())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await f.rows()).toHaveLength(0);
  });
  it('returns not found for a foreign household even without an SMS transport', async () => {
    const f = await fixture(), foreign = await fixture();
    const unconfigured = createSignedLinksService({ scope: db.forGym, clock: f.clock });
    await expect(unconfigured.send(f.context, { ...f.request(), householdId: foreign.home.id, recipientMemberId: foreign.member.id }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await f.rows()).toHaveLength(0);
  });
  it('replays one generation even after consent is withdrawn; a new generation sends again', async () => {
    const f = await fixture(), request = f.request(), first = await f.links.send(f.context, request);
    await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
    expect(await f.links.send(f.context, { ...request, expiresAt: '2026-11-21T12:00:00Z' })).toEqual(first);
    expect(f.sms.messages).toHaveLength(1);
    expect(await f.rows()).toHaveLength(1);
    await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: f.clock.now(), smsNoticesConsentSource: 'staff' }).where(eq(households.id, f.home.id)));
    expect((await f.links.send(f.context, f.request())).id).not.toBe(first.id);
    expect(f.sms.messages).toHaveLength(2);
  });
  it('never resends an unknown outcome, including a stale sending reservation', async () => {
    const f = await fixture(), request = f.request();
    f.sms.respondNext(new DeliveryError('unknown', 'Reply lost'));
    await expect(f.links.send(f.context, request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await f.links.send(f.context, request)).toMatchObject({ outcome: 'unknown', revokedAt: null });
    await db.forGym(f.gymId, tx => tx.update(smsDeliveries).set({ state: 'sending' }));
    f.clock.advance(smsInFlightMs + 1);
    expect(await f.links.send(f.context, request)).toMatchObject({ outcome: 'unknown', revokedAt: null });
    expect(await f.rows()).toHaveLength(1);
    expect(f.sms.messages).toHaveLength(0);
  });
  it.each(['not_accepted', 'suppressed'] as const)('releases a %s attempt and revokes its undisclosed credential', async reason => {
    const f = await fixture(), request = f.request();
    f.sms.respondNext(reason === 'not_accepted' ? new DeliveryError('not_accepted', 'Refused') : { status: 'suppressed', reason: 'disabled' });
    await expect(f.links.send(f.context, request)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await f.rows())[0]!.revokedAt).not.toBeNull();
    const retried = await f.links.send(f.context, request);
    expect(retried.revokedAt).toBeNull();
    expect(await f.links.send(f.context, request)).toEqual(retried);
    expect(f.sms.messages).toHaveLength(1);
  });
  it('refuses a generation reused for another recipient and serializes concurrent sends', async () => {
    const f = await fixture(), request = f.request();
    const results = await Promise.allSettled([f.links.send(f.context, request), f.links.send(f.context, request)]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(f.sms.messages).toHaveLength(1);
    expect(await f.rows()).toHaveLength(1);
    await expect(f.links.send(f.context, { ...request, recipientMemberId: f.member.id })).rejects.toMatchObject({ code: 'conflict' });
    f.clock.set('2026-11-20T12:00:00Z');
    expect(await f.links.resolve(f.gymId, f.token())).toEqual({ status: 'expired' });
  });
  it('rechecks consent after preparation and releases a last-moment suppression', async () => {
    const f = await fixture();
    f.resolver.resolve = async () => {
      await db.forGym(f.gymId, tx => tx.update(households).set({ smsNoticesConsentAt: null, smsNoticesConsentSource: null }).where(eq(households.id, f.home.id)));
      return { gymId: f.gymId, name: 'Gym', sms: f.sms };
    };
    await expect(f.links.send(f.context, f.request())).rejects.toMatchObject({ code: 'unavailable' });
    expect((await f.rows())[0]!.revokedAt).not.toBeNull();
    expect((await db.forGym(f.gymId, tx => tx.select().from(smsDeliveries)))[0]!.state).toBe('not_accepted');
    expect(f.sms.messages).toHaveLength(0);
  });
  it('never texts a member who moves households while the provider is being resolved', async () => {
    const f = await fixture(), other = await make('households', f.gymId);
    f.resolver.resolve = async () => {
      await db.forGym(f.gymId, tx => tx.update(members).set({ householdId: other.id }).where(eq(members.id, f.member.id)));
      return { gymId: f.gymId, name: 'Gym', sms: f.sms };
    };
    await expect(f.links.send(f.context, { ...f.request(), recipientMemberId: f.member.id })).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.sms.messages).toHaveLength(0);
    expect((await f.rows())[0]!.revokedAt).not.toBeNull();
  });
  it('texts manual instructions without an active credential for amounts below the card minimum', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(invoices).set({ amountCents: 1 }).where(eq(invoices.id, f.invoice.id)));
    const request = { ...f.request(), purpose: 'pay_invoice' as const, invoiceId: f.invoice.id };
    const sent = await f.links.send(f.context, request);
    expect(sent.revokedAt).not.toBeNull();
    expect(f.sms.messages[0]!.body).toContain('manual payment');
    expect(f.sms.messages[0]!.body).not.toContain('/l/');
    expect(await f.links.send(f.context, request)).toEqual(sent);
    expect(f.sms.messages).toHaveLength(1);
  });
  it.each(['owner', 'admin', 'front_desk', 'coach'] as const)('enforces links.send for %s', async role => {
    const f = await fixture();
    const response = await f.app(role).request('/api/links/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f.request()) });
    expect(response.status).toBe(role === 'coach' ? 403 : 200);
    expect(f.sms.messages).toHaveLength(role === 'coach' ? 0 : 1);
  });
});

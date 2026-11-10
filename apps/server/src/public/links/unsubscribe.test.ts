// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { announcementOptOuts, auditEvents, members, signedLinks, uuidv7 } from '@plaingym/db';
import { createFactories } from '@plaingym/db/testing/factories';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createApp } from '../../app.js';
import { TestClock } from '../../core/clock.js';
import type { Principal } from '../../core/context.js';
import { areaContributions } from '../../core/registry-areas.js';
import { authorize } from '../../areas/staff/auth.permissions.js';
import { createSignedLinksService } from '../../areas/links/service.js';
import { issueUnsubscribeLink } from '../../areas/announcements/unsubscribe.js';
import { createWaiversService } from '../../areas/waivers/waivers.js';
import { createSignedLinkCheckout } from '../../areas/billing/signed-link-checkout.js';
import { FakePayments } from '../../infra/payments/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { configureLinkPages } from './links.routes.js';

const db = useTestDatabase(), factory = createFactories(db), origin = 'https://gym.example.test';
const api = '/api/links/unsubscribe', oneClickBody = 'List-Unsubscribe=One-Click';
async function fixture() {
  const gymId = uuidv7(), otherGym = uuidv7(), clock = new TestClock('2026-11-09T12:00:00Z');
  await factory('gyms', gymId); await factory('gyms', otherGym);
  const member = await factory('members', gymId, { firstName: 'Target', email: 'secret@example.test', emailOptOut: true });
  const sibling = await factory('members', gymId, { householdId: member.householdId, firstName: 'Sibling' });
  const outsider = await factory('members', gymId, { firstName: 'Outsider' });
  const token = await db.forGym(gymId, tx => issueUnsubscribeLink(tx, gymId, member.id, clock.now()));
  const [row] = await db.forGym(gymId, tx => tx.select().from(signedLinks));
  const links = createSignedLinksService({ scope: db.forGym, clock });
  const payments = new FakePayments(gymId, clock), uploads = new FakeUploads(gymId, clock);
  configureLinkPages({ scope: db.forHousehold, links, receiptKey: new Uint8Array(32).fill(7),
    gymNameFor: async () => 'Example Academy', stylesheet: async () => '', browserScript: async () => '',
    waivers: createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads }),
    checkout: createSignedLinkCheckout({ scope: db.forGym, clock, paymentsFor: async () => payments, originFor: async () => origin }) });
  const app = (resolvedGym = gymId, principal: Principal = { kind: 'anonymous' }) => createApp({ clock, skipSetup: true,
    authorize, origin, contributions: areaContributions, rateLimit: { limit: 10000 },
    resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: resolvedGym, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
    session: async (c, next) => { c.set('context', { ...c.get('context'), principal }); await next(); } });
  const server = app();
  const request = (method = 'GET', body?: unknown, credential = token, application = server) => application.request(origin + api,
    { method, headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const click = (body = oneClickBody, credential = token, application = server, headers = {}) => application.request(origin + '/l/' + credential,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  return { gymId, otherGym, clock, member, sibling, outsider, token, row: row!, links, app, server, request, click };
}

it('GET has no side effects and the page and API show only the linked member, gym and announcement preference', async () => {
  const f = await fixture();
  const before = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
  for (let i = 0; i < 2; i++) {
    const response = await f.server.request(origin + '/l/' + f.token), html = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('Example Academy'); expect(html).toContain('Target'); expect(html).toContain('Unsubscribe');
    for (const privateText of ['Sibling', 'Outsider', 'secret@example.test', f.member.householdId, f.sibling.id, f.outsider.id,
      'data-checkout', 'data-waiver=', 'data-complete=']) expect(html).not.toContain(privateText);
    expect(html).not.toContain('Complete these steps');  }
  expect(await (await f.request()).json()).toEqual({ data: { purpose: 'unsubscribe',
    member: { firstName: f.member.firstName, lastName: f.member.lastName }, optedOut: false } });
  expect(await db.forGym(f.gymId, tx => tx.select().from(announcementOptOuts))).toEqual([]);
  expect(await db.forGym(f.gymId, tx => tx.select().from(auditEvents))).toEqual(before);
});

it('one-click works without cookies, repeats safely, and the page button can resubscribe only its member', async () => {
  const f = await fixture();
  for (const person of [f.sibling, f.outsider]) await factory('announcementOptOuts', f.gymId, { memberId: person.id });
  for (let i = 0; i < 2; i++) {
    const response = await f.click(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { optedOut: true } });
    expect(response.headers.has('set-cookie')).toBe(false);
  }
  const html = await (await f.server.request(origin + '/l/' + f.token)).text();
  expect(html).toContain('Target'); expect(html).toContain('is unsubscribed'); expect(html).toContain('Subscribe again');
  expect((await f.request('POST', { optedOut: false })).status).toBe(200);
  expect((await db.forGym(f.gymId, tx => tx.select().from(announcementOptOuts))).map(row => row.memberId).sort())
    .toEqual([f.sibling.id, f.outsider.id].sort());
  expect((await f.request('POST', { optedOut: true })).status).toBe(200);
  expect((await f.links.resolve(f.gymId, f.token)).status).toBe('active');
  expect((await db.forGym(f.gymId, tx => tx.select().from(members).where(eq(members.id, f.member.id))))[0]!.emailOptOut).toBe(true);
});

it('refuses every other one-click body and resource selectors, and retains browser CSRF checks', async () => {
  const f = await fixture();
  for (const body of ['', 'List-Unsubscribe=one-click', 'List-Unsubscribe=One-Click&memberId=' + f.sibling.id,
    'List-Unsubscribe=One-Click&List-Unsubscribe=One-Click', 'List-Unsubscribe=One%2DClick', 'List-Unsubscribe=One-Click\n', '{"List-Unsubscribe":"One-Click"}'])
    expect((await f.click(body)).status, body).toBe(400);
  expect((await f.click(oneClickBody, f.token, f.server, { 'content-type': 'text/plain' })).status).toBe(400);
  expect((await f.click(oneClickBody, f.token, f.server, { cookie: 'session=fake', origin: 'https://other.example.test' })).status).toBe(403);
  for (const memberId of [f.sibling.id, f.outsider.id])
    expect((await f.request('POST', { optedOut: true, memberId })).status).toBe(400);
  expect((await f.server.request(origin + api + '?memberId=' + f.sibling.id, { headers: { authorization: 'Bearer ' + f.token } })).status).toBe(400);
  for (const fields of [[], [['List-Unsubscribe', 'one-click']], [['List-Unsubscribe', 'One-Click'], ['memberId', f.sibling.id]],
    [['List-Unsubscribe', 'One-Click'], ['List-Unsubscribe', 'One-Click']]]) {
    const body = new FormData(); for (const [name, value] of fields) body.append(name!, value!);
    expect((await f.server.request(origin + '/l/' + f.token, { method: 'POST', body })).status, JSON.stringify(fields)).toBe(400);
  }
  expect((await f.click('--x\r\nbroken', f.token, f.server, { 'content-type': 'multipart/form-data; boundary=x' })).status).toBe(400);
  expect(await db.forGym(f.gymId, tx => tx.select().from(announcementOptOuts))).toEqual([]);
});

it('one-click also accepts the RFC 8058 multipart/form-data body and opts out only its member', async () => {
  const f = await fixture(), body = new FormData();
  body.append('List-Unsubscribe', 'One-Click');
  const response = await f.server.request(origin + '/l/' + f.token, { method: 'POST', body });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: { optedOut: true } });
  expect((await db.forGym(f.gymId, tx => tx.select().from(announcementOptOuts))).map(row => row.memberId)).toEqual([f.member.id]);
});

it('unknown, expired, revoked, used and cross-gym tokens have the same one-click response and cannot mutate preferences', async () => {
  const f = await fixture(), responses: string[] = [], unavailablePages: string[] = [];
  const capture = async (token: string, server = f.server, used = false) => {
    const response = await f.click(oneClickBody, token, server); expect(response.status).toBe(404);
    const json = await response.json() as { error: { code: string; message: string } }; responses.push(JSON.stringify(json.error));
    expect((await f.request('POST', { optedOut: true }, token, server)).status).toBe(404);
    expect((await f.request('GET', undefined, token, server)).status).toBe(404);
    const page = await server.request(origin + '/l/' + token), html = await page.text();
    expect(page.status).toBe(used ? 200 : 404);
    expect(html).not.toContain('Target');
    if (!used) unavailablePages.push(html);
  };
  await capture('x'.repeat(43)); await capture(f.token, f.app(f.otherGym));
  for (const state of ['expired', 'revoked', 'used'] as const) {
    await db.forGym(f.gymId, tx => tx.update(signedLinks).set({
      expiresAt: state === 'expired' ? f.clock.now() : new Date('2027-01-01Z'),
      revokedAt: state === 'revoked' ? f.clock.now() : null, usedAt: state === 'used' ? f.clock.now() : null,
    }).where(eq(signedLinks.id, f.row.id)));
    await capture(f.token, f.server, state === 'used');
  }
  expect(new Set(responses).size).toBe(1);
  expect(new Set(unavailablePages).size).toBe(1);
  expect(await db.forGym(f.gymId, tx => tx.select().from(announcementOptOuts))).toEqual([]);
});

it('requires the unsubscribe purpose and refuses staff, household and device credentials on its API', async () => {
  const f = await fixture();
  const other = await f.links.create({ gymId: f.gymId, actor: { kind: 'system' } }, { purpose: 'update_card',
    householdId: f.member.householdId, expiresAt: new Date('2027-01-01Z').toISOString() });
  expect((await f.click(oneClickBody, other.token)).status).toBe(404);
  for (const method of ['GET', 'POST']) {
    expect((await f.request(method, method === 'POST' ? { optedOut: true } : undefined, other.token)).status).toBe(403);
    for (const principal of [{ kind: 'anonymous' }, ...['owner', 'admin', 'coach', 'front_desk'].map(role => ({ kind: 'staff',
      gymId: f.gymId, userId: uuidv7(), roles: [role] })), { kind: 'member', userId: uuidv7(),
      scope: { gymId: f.gymId, householdId: f.member.householdId, role: 'payer', memberId: null } },
    { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }] as Principal[]) {
      const response = await f.app(f.gymId, principal).request(origin + api, { method, headers: { 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{"optedOut":true}' } : {}) });
      expect(response.status).toBe(401);
    }
  }
  for (const purpose of ['pay-invoice', 'update-card', 'sign-waiver', 'onboarding'])
    expect((await f.server.request(origin + '/api/links/' + purpose, { headers: { authorization: 'Bearer ' + f.token } })).status).toBe(403);
  const limited = await fixture();
  for (let i = 0; i < 30; i++) expect((await (i % 2 ? limited.click() : limited.request('POST', { optedOut: true }))).status).toBe(200);
  expect((await limited.click()).status).toBe(429);
  expect((await limited.request('POST', { optedOut: false })).status).toBe(429);
});

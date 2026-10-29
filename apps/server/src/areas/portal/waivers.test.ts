// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, waiverSignatures } from '@plaingym/db';
// eslint-disable-next-line no-restricted-imports -- Initialize the default app-role pools for the production registrations; no raw queries.
import { initializeDatabase, closeDatabase } from '@plaingym/db/client';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { portalContracts as contracts, waiverUploadResponseSchema } from '@plaingym/shared/contracts';
import { TestClock } from '../../core/clock.js';
import { areaContributions } from '../../core/registry-areas.js';
import type { Principal } from '../../core/context.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from '../waivers/waivers.js';
import { createMemberHouseholdContext } from '../members/household-users.context.js';
import { createPortalWaiverService } from './waivers.js';
import { configurePortalWaivers, createPortalWaiverRoutes } from './waivers.routes.js';
import { adultPrincipal, otherPayerPrincipal, outsidePrincipals, payerPrincipal, portalApp, portalFixture, send } from './household.fixture.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-29T16:00:00Z');
const png = Buffer.from(demoSignaturePng()).toString('base64');
beforeAll(() => initializeDatabase(db.appUrl));
afterAll(closeDatabase);
async function fixture() {
  const f = await portalFixture(factory), uploads = new FakeUploads(f.gymId, clock);
  const waivers = createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads, render: async () => new Uint8Array([37, 80, 68, 70]) });
  const ctx = { gymId: f.gymId, actor: { kind: 'system' as const } };
  const waiver = await waivers.createTemplate(ctx, { name: 'Participation', kind: 'waiver', body: 'I agree.' });
  const agreement = await waivers.createTemplate(ctx, { name: 'Membership agreement', kind: 'agreement', body: 'Terms.' });
  return { ...f, uploads, waivers, ctx, waiver, agreement };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function app(f: Fixture, principal: Principal, production = false) {
  if (production) { configurePortalWaivers(f.waivers); return portalApp(db, f, principal, areaContributions.routes ?? [], clock); }
  const service = createPortalWaiverService({ waivers: () => f.waivers, households: createMemberHouseholdContext(db.forGym), householdScope: db.forHousehold });
  return portalApp(db, f, principal, createPortalWaiverRoutes(service), clock);
}
async function sign(server: ReturnType<typeof app>, base: string, memberId: string, templateId: string, signer: object = { kind: 'self', name: 'Alex Rivera' }) {
  const upload = await send(server, 'POST', `${base}/signature-images`, { memberId, pngBase64: png });
  expect(upload.status).toBe(200);
  const image = waiverUploadResponseSchema.parse(await upload.json()).data;
  return send(server, 'POST', base, { memberId, templateId, templateVersion: 1, signer, consent: true, ...image });
}
/** Every waiver route with a valid request for the member, so a denial is never a validation error. */
function routes(base: string, memberId: string, signatureId: string, templateId: string) {
  const image = { signatureImageKey: `x/waivers/${memberId}/signatures/a.png`, signatureImageHash: '0'.repeat(64) };
  return [['GET', `${base}/pending?memberId=${memberId}`], ['GET', `${base}?memberId=${memberId}`],
    ['POST', `${base}/signature-images`, { memberId, pngBase64: png }],
    ['POST', base, { memberId, templateId, templateVersion: 1, signer: { kind: 'self', name: 'X' }, consent: true, ...image }],
    ['GET', `${base}/${signatureId}/pdf`]] as const;
}

describe('portal waiver routes', () => {
  it('lets a member sign their own pending waivers, list them and download a PDF; signing stays immutable', async () => {
    const f = await fixture(), server = app(f, adultPrincipal(f));
    const pending = await send(server, 'GET', '/api/portal/waivers/pending');
    expect(contracts.pendingWaivers.response.parse(await pending.json()).data.map(row => [row.memberId, row.template.id]))
      .toEqual([[f.adult.id, f.agreement.id], [f.adult.id, f.waiver.id]]);
    const signed = await sign(server, '/api/portal/waivers', f.adult.id, f.waiver.id);
    expect(signed.status).toBe(200);
    const row = contracts.signWaiver.response.parse(await signed.json()).data;
    expect(row.memberId).toBe(f.adult.id);
    const after = contracts.pendingWaivers.response.parse(await (await send(server, 'GET', '/api/portal/waivers/pending')).json());
    expect(after.data.map(item => item.template.id)).toEqual([f.agreement.id]);
    const list = contracts.signedWaivers.response.parse(await (await send(server, 'GET', '/api/portal/waivers')).json());
    expect(list.data.map(item => item.id)).toEqual([row.id]);
    const pdf = await send(server, 'GET', `/api/portal/waivers/${row.id}/pdf`);
    expect(contracts.waiverPdf.response.parse(await pdf.json()).data.url).toMatch(/^https:/);
    // Replaying the same image returns the stored signature; a different signer is refused, never an update.
    const replay = await send(server, 'POST', '/api/portal/waivers', { memberId: f.adult.id, templateId: f.waiver.id, templateVersion: 1,
      signer: { kind: 'self', name: 'Someone Else' }, consent: true, signatureImageKey: row.signatureImageKey, signatureImageHash: row.signatureImageHash });
    expect(replay.status).toBe(409);
    const [stored] = await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures).where(eq(waiverSignatures.id, row.id)));
    expect(stored).toMatchObject({ snapshot: row.snapshot, snapshotHash: row.snapshotHash });
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.targetId, row.id)));
    expect(audits).toEqual([expect.objectContaining({ action: 'waiver.signed', actorKind: 'user', actorUserId: f.adultUser.id })]);
  });
  it('lets the payer sign for a child as guardian through the household routes', async () => {
    const f = await fixture(), server = app(f, payerPrincipal(f));
    const pending = contracts.pendingHouseholdWaivers.response.parse(await (await send(server, 'GET', '/api/portal/household/waivers/pending')).json());
    expect(new Set(pending.data.map(row => row.memberId))).toEqual(new Set([f.payer.id, f.child.id, f.adult.id]));
    expect((await sign(server, '/api/portal/household/waivers', f.child.id, f.waiver.id)).status).toBe(400);
    const guardian = await sign(server, '/api/portal/household/waivers', f.child.id, f.waiver.id, { kind: 'guardian', name: 'Pat Rivera', relationship: 'Parent' });
    expect(guardian.status).toBe(200);
    const signature = contracts.signHouseholdWaiver.response.parse(await guardian.json()).data;
    const listed = contracts.signedHouseholdWaivers.response.parse(await (await send(server, 'GET', `/api/portal/household/waivers?memberId=${f.child.id}`)).json());
    expect(listed.data.map(row => row.id)).toEqual([signature.id]);
    expect((await send(server, 'GET', `/api/portal/household/waivers/${signature.id}/pdf`)).status).toBe(200);
    // The self routes cover only the payer's own member.
    expect((await send(server, 'GET', `/api/portal/waivers?memberId=${f.child.id}`)).status).toBe(404);
    expect((await send(server, 'GET', `/api/portal/waivers/${signature.id}/pdf`)).status).toBe(404);
  });
  it('lets the payer sign for themselves but not as another adult', async () => {
    const f = await fixture(), server = app(f, payerPrincipal(f));
    expect((await sign(server, '/api/portal/household/waivers', f.payer.id, f.waiver.id, { kind: 'self', name: 'Pat Rivera' })).status).toBe(200);
    expect((await send(server, 'POST', '/api/portal/household/waivers/signature-images', { memberId: f.adult.id, pngBase64: png })).status).toBe(403);
    const image = await f.waivers.uploadSignature(f.ctx, f.adult.id, demoSignaturePng());
    expect((await send(server, 'POST', '/api/portal/household/waivers', { memberId: f.adult.id, templateId: f.waiver.id, templateVersion: 1,
      signer: { kind: 'self', name: 'Alex Rivera' }, consent: true, ...image })).status).toBe(403);
    const rows = await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures));
    expect(rows.map(row => row.memberId)).toEqual([f.payer.id]);
  });
  it('refuses the payer for an adult with no birth date, who still signs from their own login', async () => {
    const f = await fixture(), server = app(f, payerPrincipal(f));
    const unknown = await factory('members', f.gymId, { householdId: f.household.id, firstName: 'Imported', lastName: 'Adult', dateOfBirth: null });
    const login = await factory('authUser', f.gymId);
    await factory('householdUsers', f.gymId, { householdId: f.household.id, userId: login.id, memberId: unknown.id, scope: 'member' });
    const guardian = { kind: 'guardian', name: 'Pat Rivera', relationship: 'Parent' };
    expect((await send(server, 'POST', '/api/portal/household/waivers/signature-images', { memberId: unknown.id, pngBase64: png })).status).toBe(403);
    const image = await f.waivers.uploadSignature(f.ctx, unknown.id, demoSignaturePng());
    for (const signer of [guardian, { kind: 'self', name: 'Imported Adult' }])
      expect((await send(server, 'POST', '/api/portal/household/waivers', { memberId: unknown.id, templateId: f.waiver.id, templateVersion: 1, signer, consent: true, ...image })).status).toBe(403);
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toEqual([]);
    // From their own login the member signs; with no recorded birth date the waiver service still asks for a guardian signer.
    const own = app(f, { kind: 'member', userId: login.id, scope: { gymId: f.gymId, householdId: f.household.id, memberId: unknown.id, role: 'member' } });
    const signed = await sign(own, '/api/portal/waivers', unknown.id, f.waiver.id, { kind: 'guardian', name: 'Imported Adult', relationship: 'Self' });
    expect(signed.status).toBe(200);
    expect(contracts.signWaiver.response.parse(await signed.json()).data.memberId).toBe(unknown.id);
  });
  it('keeps an adult non-payer to their own waivers', async () => {
    const f = await fixture(), payer = app(f, payerPrincipal(f));
    const child = contracts.signHouseholdWaiver.response.parse(await (await sign(payer, '/api/portal/household/waivers', f.child.id, f.waiver.id,
      { kind: 'guardian', name: 'Pat', relationship: 'Parent' })).json()).data;
    const server = app(f, adultPrincipal(f));
    for (const memberId of [f.child.id, f.payer.id])
      for (const [method, path, body] of routes('/api/portal/waivers', memberId, child.id, f.waiver.id))
        expect((await send(server, method, path, body)).status, `${method} ${path}`).toBe(404);
    for (const [method, path, body] of routes('/api/portal/household/waivers', f.adult.id, child.id, f.waiver.id))
      expect((await send(server, method, path, body)).status, `${method} ${path}`).toBe(404);
    expect(contracts.signedWaivers.response.parse(await (await send(server, 'GET', '/api/portal/waivers')).json()).data).toEqual([]);
  });
  it('returns 404 for other households, other gyms and non-member sessions on every route', async () => {
    const f = await fixture(), foreign = await fixture();
    const outsider = await f.waivers.sign(f.ctx, { memberId: f.outsider.id, templateId: f.waiver.id, templateVersion: 1, consent: true,
      signer: { kind: 'guardian', name: 'Other', relationship: 'Parent' }, ...await f.waivers.uploadSignature(f.ctx, f.outsider.id, demoSignaturePng()) },
    { timezone: 'UTC', ipAddress: '192.0.2.1' });
    const payer = app(f, payerPrincipal(f));
    for (const [memberId, signatureId] of [[f.outsider.id, outsider.id], [foreign.child.id, outsider.id]] as const)
      for (const base of ['/api/portal/waivers', '/api/portal/household/waivers'])
        for (const [method, path, body] of routes(base, memberId, signatureId, f.waiver.id))
          expect((await send(payer, method, path, body)).status, `${method} ${path}`).toBe(404);
    const other = app(f, otherPayerPrincipal(f));
    expect(contracts.signedHouseholdWaivers.response.parse(await (await send(other, 'GET', '/api/portal/household/waivers')).json()).data.map(row => row.id)).toEqual([outsider.id]);
    for (const principal of [payerPrincipal(foreign), adultPrincipal(foreign), ...outsidePrincipals(f)]) {
      const server = app(f, principal);
      for (const base of ['/api/portal/waivers', '/api/portal/household/waivers'])
        for (const [method, path, body] of routes(base, f.child.id, outsider.id, f.waiver.id))
          expect([404], `${method} ${path}`).toContain((await send(server, method, path, body)).status);
    }
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toHaveLength(1);
  });
  it('serves the production registrations with the configured waiver service', async () => {
    const f = await fixture(), server = app(f, adultPrincipal(f), true);
    expect((await sign(server, '/api/portal/waivers', f.adult.id, f.waiver.id)).status).toBe(200);
  });
});

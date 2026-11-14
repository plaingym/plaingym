// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { canStaff, type StaffRole } from '@plaingym/shared';
import { waiverContracts } from '@plaingym/shared/contracts';
import type { Principal, RequestEnvironment } from '../../core/context.js';
import { createServerRegistry } from '../../core/registry.js';
import { errorHandler } from '../../core/errors.js';
import { TestClock } from '../../core/clock.js';
import { authorize } from '../staff/auth.permissions.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from './waivers.js';
import { documentReadBudget } from './document-read.js';
import { createWaiverRoutes } from './waivers.routes.js';
import { configureWaivers } from './waivers.routes.js';
import { createApp } from '../../app.js';
import { areaContributions } from '../../core/registry-areas.js';
import { createUploadDownloadRoute } from '../../core/uploads-download.js';
import { LocalUploads } from '../../infra/storage/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWaiverDocumentDelivery } from './document-delivery.js';
import { waiverDocumentFixture } from './document.fixture.js';
import { defaultBodyLimits } from '../../core/body-limit.js';
import { documentByteLimit } from '../../infra/pdf/document.js';
import { waiverPdf } from '../../../../../deploy/test/memory/waiver-pdf.mjs';
const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-10-24T12:00:00Z');
type Operation = keyof typeof waiverContracts;
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const user = await factory('authUser', gymId), member = await factory('members', gymId, { dateOfBirth: '1990-01-01' });
  const uploads = new FakeUploads(gymId, clock), context = { gymId, actor: { kind: 'system' as const } };
  const uploadsFor = async () => uploads;
  const documentDelivery = createWaiverDocumentDelivery({ uploadsFor, clock, key: new Uint8Array(32).fill(3), originFor: async () => 'https://gym.example.test' });
  const service = createWaiversService({ scope: db.forGym, clock, uploadsFor, documentDelivery });
  const template = await service.createTemplate(context, { name: 'Participation', kind: 'waiver', body: 'Terms' });
  const image = await service.uploadSignature(context, member.id, demoSignaturePng());
  const input = { memberId: member.id, templateId: template.id, templateVersion: 1, signer: { kind: 'self' as const, name: 'Member' }, ...image, consent: true as const };
  const signature = await service.sign(context, input, { timezone: 'UTC', ipAddress: 'unknown' });
  return { gymId, user, member, uploads, service, template, input, signature };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function server(f: Fixture, principal: Principal) {
  const app = new OpenAPIHono<RequestEnvironment>();
  app.use('*', async (ctx, next) => { ctx.set('context', { gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() }, principal, clock, requestId: 'waivers-test', clientIp: ctx.req.header('test-ip') ?? '192.0.2.1' }); await next(); });
  app.onError(errorHandler); createServerRegistry({ routes: createWaiverRoutes(f.service) }).mount(app, authorize, new Set());
  return app;
}
const staff = (f: Fixture, role: StaffRole): Principal => ({ kind: 'staff', gymId: f.gymId, userId: f.user.id, roles: [role] });
it.each([undefined, 'not json'])('rejects a missing or non-JSON waiver body: %s', async (body) => {
  const f = await fixture();
  const response = await server(f, staff(f, 'owner')).request('/api/waivers/templates', { method: 'POST', ...(body === undefined ? {} : { body }) });
  expect(response.status).toBe(400);
  // A bodyless request can be refused by OpenAPI validation before the JSON reader.
  if (body !== undefined) expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
});
async function request(app: ReturnType<typeof server>, operation: Operation, f: Fixture) {
  const contract = waiverContracts[operation];
  if (operation === 'uploadDocument') return app.request(contract.path, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Uint8Array.from(await waiverDocumentFixture()) });
  if (operation === 'document') {
    const ctx = { gymId: f.gymId, actor: { kind: 'system' as const } };
    const document = await f.service.uploadDocument(ctx, await waiverDocumentFixture());
    const template = await f.service.createTemplate(ctx, { name: 'Uploaded document ' + uuidv7(), kind: 'waiver', body: '', document });
    return app.request(contract.path.replace('{templateId}', template.id));
  }
  const bodies: Partial<Record<Operation, unknown>> = {
    createTemplate: { name: 'Another template', kind: 'agreement', body: 'Terms' },
    publishTemplate: { name: f.template.name, kind: 'waiver', body: 'Updated', expectedVersion: 1 },
    retireTemplate: { expectedVersion: 1 }, sign: f.input,
    uploadSignature: { memberId: f.member.id, pngBase64: demoSignaturePng().toString('base64') },
  };
  return app.request(contract.path.replace('{templateId}', f.template.id).replace('{signatureId}', f.signature.id), {
    method: contract.method.toUpperCase(), ...(bodies[operation] ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodies[operation]) } : {}),
  });
}
describe('waiver route authorization', () => {
  it('keeps upload and document-read budgets independent and scopes reads to each client', async () => {
    const f = await fixture(), app = server(f, staff(f, 'owner'));
    const context = { gymId: f.gymId, actor: { kind: 'system' as const } };
    const document = await f.service.uploadDocument(context, await waiverDocumentFixture());
    const template = await f.service.createTemplate(context, { name: 'PDF terms', kind: 'waiver', body: '', document });
    for (let i = 0; i < 10; i++) {
      const response = await app.request('/api/waivers/template-documents', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: 'invalid' });
      expect(response.status).toBe(400);
    }
    expect((await app.request('/api/waivers/template-documents', { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: 'invalid' })).status).toBe(429);
    const path = `/api/waivers/templates/${template.id}/document`;
    for (let i = 0; i < documentReadBudget; i++) expect((await app.request(path)).status).toBe(200);
    expect((await app.request(path)).status).toBe(429);
    expect((await app.request(path, { headers: { 'test-ip': '192.0.2.2' } })).status).toBe(200);
  });
  for (const operation of Object.keys(waiverContracts) as Operation[]) {
    for (const role of ['owner', 'admin', 'coach', 'front_desk'] as const) it(`${operation}: ${role}`, async () => {
      const f = await fixture(), response = await request(server(f, staff(f, role)), operation, f);
      expect(response.status, await response.clone().text()).toBe(canStaff([role], waiverContracts[operation].permission.capability) ? 200 : 403);
      if (response.ok) { const body = await response.json(); expect(() => waiverContracts[operation].response.parse(body)).not.toThrow(); }
    });
    it(`${operation}: denies anonymous, member and kiosk`, async () => {
      const f = await fixture();
      for (const principal of [{ kind: 'anonymous' }, { kind: 'kiosk', gymId: f.gymId, deviceId: uuidv7() }] as const)
        expect((await request(server(f, principal), operation, f)).status).toBe(principal.kind === 'anonymous' ? 401 : 403);
      // Both household scopes are rejected at this staff-only surface.
      for (const householdId of [f.member.householdId, uuidv7()]) {
        const principal = { kind: 'member', userId: f.user.id, scope: { gymId: f.gymId, householdId, kind: 'payer' } } as unknown as Principal;
        expect((await request(server(f, principal), operation, f)).status).toBe(403);
      }
    });
  }
  for (const operation of ['publishTemplate', 'retireTemplate', 'sign', 'pdf', 'uploadSignature', 'document'] as const) it(`${operation}: another gym is 404`, async () => {
    const own = await fixture(), other = await fixture();
    expect((await request(server(own, staff(own, 'owner')), operation, other)).status).toBe(404);
  });
  it('scopes list results and validates cross-gym signature filters', async () => {
    const f = await fixture(), other = await fixture(), app = server(f, staff(f, 'owner'));
    const listed = await app.request('/api/waivers/templates');
    expect(waiverContracts.listTemplates.response.parse(await listed.json()).data.map(r => r.id)).toEqual([f.template.id]);
    for (const query of ['memberId=' + other.member.id, 'templateId=' + other.template.id]) expect((await app.request('/api/waivers/signatures?' + query)).status).toBe(404);
    const signatures = waiverContracts.listSignatures.response.parse(await (await app.request('/api/waivers/signatures')).json());
    expect(signatures.data.map(r => r.id)).toEqual([f.signature.id]);
  });
  it.each([false, true])('composes the real registrations and follows immutable local downloads (PDF template: %s)', async pdfTemplate => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), 'plaingym-waivers-')), origin = 'https://gym.example.test';
    try {
      const uploads = new LocalUploads({ root, gymId: f.gymId, signingKey: new Uint8Array(32).fill(3), clock, downloadUrl: origin + '/api/uploads/download' });
      const uploadsFor = async () => uploads;
      const documentDelivery = createWaiverDocumentDelivery({ uploadsFor, clock, key: new Uint8Array(32).fill(7), originFor: async () => origin });
      const service = configureWaivers({ scope: db.forGym, clock, uploadsFor, documentDelivery });
      const ctx = { gymId: f.gymId, actor: { kind: 'system' as const } };
      const image = await service.uploadSignature(ctx, f.member.id, demoSignaturePng());
      const app = createApp({ clock, origin, skipSetup: true, authorize,
        bodyLimits: { ...defaultBodyLimits, routes: { ...defaultBodyLimits.routes, [waiverContracts.uploadDocument.path]: documentByteLimit } },
        contributions: { ...areaContributions, routes: [...areaContributions.routes, createUploadDownloadRoute({ uploadsFor, origin: () => origin })] },
        resolveGym: async (c, next) => { c.set('context', { ...c.get('context'), gym: { gymId: f.gymId, timezone: 'UTC', enabledModules: new Set() } }); await next(); },
        session: async (c, next) => { c.set('context', { ...c.get('context'), principal: staff(f, 'owner') }); await next(); },
      });
      let template = f.template;
      if (pdfTemplate) {
        // This composition option must reach production: the app's default 1 MiB
        // guard otherwise rejects documents that the waiver route permits.
        const bytes = waiverPdf();
        for (const framing of [{}, { 'content-length': 'invalid' }, { 'content-length': '1', 'transfer-encoding': 'chunked' },
          { 'content-length': String(documentByteLimit + 1) }] as Record<string, string>[]) {
          let pulled = 0;
          const body = new ReadableStream<Uint8Array>({ pull() { pulled++; } }, { highWaterMark: 0 });
          const rejected = await app.request(origin + waiverContracts.uploadDocument.path, { method: 'POST', body, duplex: 'half',
            headers: { origin, 'content-type': 'application/pdf', ...framing } } as RequestInit);
          expect(rejected.status).toBe(400);
          expect(pulled).toBe(0);
        }
        const uploaded = await app.request(origin + '/api/waivers/template-documents', { method: 'POST',
          headers: { origin, 'content-type': 'application/pdf', 'content-length': String(bytes.length) }, body: Uint8Array.from(bytes) });
        expect(uploaded.status, await uploaded.clone().text()).toBe(200);
        const document = waiverContracts.uploadDocument.response.parse(await uploaded.json()).data;
        expect(document).toMatchObject({ bytes: documentByteLimit, pages: 20 });
        const created = await app.request(origin + '/api/waivers/templates', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Uploaded terms', kind: 'waiver', document }) });
        expect(created.status, await created.clone().text()).toBe(200);
        template = waiverContracts.createTemplate.response.parse(await created.json()).data;
        const read = await app.request(origin + `/api/waivers/templates/${template.id}/document`);
        expect(read.status).toBe(200);
        const url = waiverContracts.document.response.parse(await read.json()).data.url;
        const original = await app.request(url);
        expect(original.status).toBe(200);
        expect(original.headers.get('content-type')).toBe('application/pdf');
        expect(original.headers.get('content-security-policy')).toContain('sandbox');
        expect(original.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
        expect(original.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        expect(original.headers.get('x-content-type-options')).toBe('nosniff');
        expect(Buffer.from(await original.arrayBuffer()).equals(bytes)).toBe(true);
      }
      const signed = await service.sign(ctx, { ...f.input, ...image, templateId: template.id, templateVersion: template.version }, { timezone: 'UTC', ipAddress: 'unknown' });
      const response = await app.request(origin + '/api/waivers/signatures/' + signed.id + '/pdf');
      expect(response.status, await response.clone().text()).toBe(200);
      const link = waiverContracts.pdf.response.parse(await response.json()).data.url;
      const download = await app.request(link); expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('attachment');
      const task = getDocument({ data: new Uint8Array(await download.arrayBuffer()), useSystemFonts: false });
      try {
        const pdf = await task.promise, page = await pdf.getPage(pdf.numPages), content = await page.getTextContent();
        expect(pdf.numPages).toBe(pdfTemplate ? 21 : 1);
        expect(content.items.flatMap(item => 'str' in item ? [item.str] : []).join(' ')).toContain(signed.snapshotHash);
      } finally { await task.destroy(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

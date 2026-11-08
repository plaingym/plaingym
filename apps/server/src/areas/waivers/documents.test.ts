// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { waiverTemplates, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { waiverCreateTemplateRequestSchema } from '@plaingym/shared/contracts';
import { FakeUploads } from '../../infra/storage/index.js';
import { TestClock } from '../../core/clock.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from './waivers.js';
import { createWaiverDocumentDelivery } from './document-delivery.js';
import { waiverDocumentFixture } from './document.fixture.js';
import { readSnapshot } from './snapshot.js';

const db = useTestDatabase(), factory = createFactories(db);
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const person = await factory('members', gymId, { firstName: 'Alex', lastName: 'Example', dateOfBirth: '2018-01-01' });
  const clock = new TestClock('2026-11-05T12:00:00Z'), uploads = new FakeUploads(gymId, clock), ctx = { gymId, actor: { kind: 'system' as const } };
  const uploadsFor = async () => uploads;
  const documentDelivery = createWaiverDocumentDelivery({ uploadsFor, clock, key: new Uint8Array(32).fill(9), originFor: async () => 'https://gym.example.test' });
  const service = createWaiversService({ scope: db.forGym, clock, uploadsFor, documentDelivery });
  const document = await service.uploadDocument(ctx, await waiverDocumentFixture());
  const template = await service.createTemplate(ctx, { name: 'Participation', kind: 'agreement', body: '', document });
  const image = await service.uploadSignature(ctx, person.id, demoSignaturePng());
  const input = { memberId: person.id, templateId: template.id, templateVersion: 1, signer: { kind: 'guardian' as const, name: 'Taylor Example', relationship: 'Parent' },
    ...image, consent: true as const, commitmentEndsOn: '2027-01-05' };
  return { gymId, clock, uploads, service, ctx, document, template, input, documentDelivery };
}
async function extracted(bytes: Uint8Array) {
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: true });
  try {
    const pdf = await task.promise, pages: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) pages.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' '));
    return pages;
  } finally { await task.destroy(); }
}
describe('uploaded waiver documents against PostgreSQL', () => {
  it('issues document links from metadata without buffering bytes, and refuses deleted uploads', async () => {
    const f = await fixture();
    f.uploads.get = async () => { throw new Error('Link issuance must not read the document'); };
    await expect(f.service.document(f.gymId, f.template.id)).resolves.toMatchObject({ data: { url: expect.any(String) } });
    await f.uploads.markDeleted(f.document.key);
    await expect(f.service.document(f.gymId, f.template.id)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('keeps the original pages and appends signing details and the snapshot hash', async () => {
    const f = await fixture(), signed = await f.service.sign(f.ctx, f.input, { timezone: 'UTC', ipAddress: 'unknown' });
    expect(readSnapshot(signed.snapshot, signed.snapshotHash).template.document).toEqual(f.document);
    await f.service.pdf(f.gymId, signed.id);
    const copy = (await f.uploads.list()).find(row => row.contentType === 'application/pdf' && row.key !== f.document.key)!;
    const pages = await extracted(new Uint8Array(await new Response(await f.uploads.get(copy.key)).arrayBuffer()));
    expect(pages).toHaveLength(3);
    expect(pages[0]).toContain('Original waiver page 1'); expect(pages[1]).toContain('Original waiver page 2');
    for (const value of ['Alex Example', 'Taylor Example', 'Parent', '2026-11-05T12:00:00.000Z', '2027-01-05', signed.snapshotHash]) expect(pages[2]).toContain(value);
    expect(pages[0]).not.toContain(signed.snapshotHash); expect(pages[1]).not.toContain(signed.snapshotHash);
    const before = pages;
    await f.service.publishTemplate(f.ctx, f.template.id, { name: f.template.name, kind: f.template.kind, body: 'Replacement text', expectedVersion: 1 });
    expect(await f.service.getSignature(f.gymId, signed.id)).toEqual(signed);
    await f.service.pdf(f.gymId, signed.id);
    const copies = (await f.uploads.list()).filter(row => row.contentType === 'application/pdf' && row.key !== f.document.key);
    expect(await extracted(new Uint8Array(await new Response(await f.uploads.get(copies.at(-1)!.key)).arrayBuffer()))).toEqual(before);
    await expect(f.service.document(f.gymId, f.template.id, true)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.document(f.gymId, f.template.id)).resolves.toMatchObject({ data: { url: expect.any(String) } });
    await f.service.retireTemplate(f.ctx, f.template.id, { expectedVersion: 2 });
    expect((await f.uploads.head(f.document.key))?.deletedAt).toBeUndefined();
  });
  it('rejects changed stored bytes during signing and signed-copy rendering', async () => {
    const f = await fixture(), signed = await f.service.sign(f.ctx, f.input, { timezone: 'UTC', ipAddress: 'unknown' });
    const originalGet = f.uploads.get.bind(f.uploads);
    f.uploads.get = async key => key === f.document.key ? new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(f.document.bytes)); controller.close();
    } }) : originalGet(key);
    await expect(f.service.pdf(f.gymId, signed.id)).rejects.toThrow('Waiver document integrity failure');
    const image = await f.service.uploadSignature(f.ctx, f.input.memberId, demoSignaturePng());
    await expect(f.service.sign(f.ctx, { ...f.input, ...image }, { timezone: 'UTC', ipAddress: 'unknown' })).rejects.toThrow('Waiver document integrity failure');
    expect((await f.service.listSignatures(f.gymId)).pagination.total).toBe(1);
  });
  it('requires exactly one document kind in contracts and the database', async () => {
    const f = await fixture();
    for (const input of [{ body: '', document: undefined }, { body: 'Terms', document: f.document }]) {
      expect(waiverCreateTemplateRequestSchema.safeParse({ name: 'Invalid', kind: 'waiver', ...input }).success).toBe(false);
    }
    await expect(db.forGym(f.gymId, tx => tx.update(waiverTemplates).set({ body: 'Ambiguous terms' }).where(eq(waiverTemplates.id, f.template.id)))).rejects.toThrow();
    const old = await f.service.createTemplate(f.ctx, { name: 'Text template', kind: 'waiver', body: 'Text remains supported.' });
    const rows = await db.forGym(f.gymId, tx => tx.select().from(waiverTemplates).where(eq(waiverTemplates.id, old.id)));
    expect(rows[0]).toMatchObject({ documentKey: null, documentHash: null, documentPages: null, documentBytes: null });
    const textSigned = await f.service.sign(f.ctx, { ...f.input, templateId: old.id, commitmentEndsOn: null }, { timezone: 'UTC', ipAddress: 'unknown' });
    expect(readSnapshot(textSigned.snapshot, textSigned.snapshotHash).template.document).toBeUndefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, members, waiverSignatures, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from './waivers.js';
import { digest, readSnapshot } from './snapshot.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng();
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const person = await factory('members', gymId, { dateOfBirth: '1990-01-01' }), clock = new TestClock('2026-10-24T12:00:00Z');
  const uploads = new FakeUploads(gymId, clock), ctx = { gymId, actor: { kind: 'system' as const } };
  const service = createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  const template = await service.createTemplate(ctx, { name: 'Participation', kind: 'waiver', body: 'I agree.\nOriginal text.' });
  const uploaded = await service.uploadSignature(ctx, person.id, png);
  const input = { memberId: person.id, templateId: template.id, templateVersion: template.version, signer: { kind: 'self' as const, name: 'Test Member' }, ...uploaded, consent: true as const };
  const signing = { timezone: 'UTC', ipAddress: '192.0.2.1' };
  return { gymId, person, ctx, clock, uploads, service, template, input, signing };
}
describe('waivers against PostgreSQL', () => {
  it('stores exact immutable bytes, audits without PII, and renders them after template and member edits', async () => {
    const f = await fixture(), signed = await f.service.sign(f.ctx, f.input, f.signing);
    expect(digest(signed.snapshot)).toBe(signed.snapshotHash);
    await f.service.publishTemplate(f.ctx, f.template.id, { name: f.template.name, kind: f.template.kind, expectedVersion: 1, body: 'New terms' });
    await db.forGym(f.gymId, tx => tx.update(members).set({ firstName: 'Changed' }).where(eq(members.id, f.person.id)));
    expect(await f.service.getSignature(f.gymId, signed.id)).toEqual(signed);
    expect(await f.service.sign(f.ctx, f.input, f.signing)).toEqual(signed);
    await expect(f.service.sign(f.ctx, { ...f.input, signer: { kind: 'self', name: 'Different signer' } }, f.signing)).rejects.toMatchObject({ code: 'conflict' });
    const result = await f.service.pdf(f.gymId, signed.id);
    expect(result.data.expiresAt).toBe('2026-10-24T12:05:00.000Z');
    const stored = (await f.uploads.list()).find(r => r.contentType === 'application/pdf')!;
    const bytes = await new Response(await f.uploads.get(stored.key)).arrayBuffer();
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe('%PDF');
    const audits = await db.forGym(f.gymId, tx => tx.select().from(auditEvents));
    expect(audits.some(r => r.action === 'waiver.signed')).toBe(true);
    expect(audits.every(r => r.actorKind === 'system' && r.before === null && r.after === null)).toBe(true);
    await expect(db.forGym(f.gymId, tx => tx.update(waiverSignatures).set({ snapshot: 'changed' }).where(eq(waiverSignatures.id, signed.id)))).rejects.toThrow();
  });
  it('serializes publication, rejects stale saves, and does not resurrect retired versions', async () => {
    const f = await fixture();
    const update = { name: f.template.name, kind: f.template.kind, body: 'Updated', expectedVersion: 1 };
    const results = await Promise.allSettled([f.service.publishTemplate(f.ctx, f.template.id, update), f.service.publishTemplate(f.ctx, f.template.id, update)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    await f.service.retireTemplate(f.ctx, f.template.id, { expectedVersion: 2 });
    await f.service.retireTemplate(f.ctx, f.template.id, { expectedVersion: 2 });
    expect((await f.service.listTemplates(f.gymId)).data).toEqual([]);
    expect((await f.service.listTemplates(f.gymId, { includeRetired: 'true' })).data).toHaveLength(1);
    await expect(f.service.sign(f.ctx, f.input, f.signing)).rejects.toMatchObject({ code: 'conflict' });
    const restored = await f.service.publishTemplate(f.ctx, f.template.id, { ...update, expectedVersion: 2 });
    expect(restored.version).toBe(3); expect(restored.retiredAt).toBeNull();
  });
  it('rejects unsupported template characters and excessive layout before storing a version', async () => {
    const f = await fixture();
    for (const body of ['Accept ✓ / ☐', 'Hello 🦄', 'line\n'.repeat(4000), 'a'.repeat(80_001)]) {
      await expect(f.service.createTemplate(f.ctx, { name: 'Rejected', kind: 'waiver', body })).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(f.service.publishTemplate(f.ctx, f.template.id, { name: f.template.name, kind: 'waiver', body, expectedVersion: 1 })).rejects.toMatchObject({ code: 'invalid_request' });
    }
    await expect(f.service.createTemplate(f.ctx, { name: 'Name 🦄', kind: 'waiver', body: 'Terms' })).rejects.toMatchObject({ message: expect.stringContaining('🦄 (U+1F984)') });
    expect((await f.service.listTemplates(f.gymId)).data.map(row => row.version)).toEqual([1]);
  });
  it('signs and renders unsupported member and signer names without changing the stored text', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(members).set({ firstName: 'שלום' }).where(eq(members.id, f.person.id)));
    const signed = await f.service.sign(f.ctx, { ...f.input, signer: { kind: 'self', name: 'Before שלום After' } }, f.signing);
    expect(readSnapshot(signed.snapshot, signed.snapshotHash)).toMatchObject({ member: { firstName: 'שלום' }, signer: { name: 'Before שלום After' } });
    await expect(f.service.pdf(f.gymId, signed.id)).resolves.toMatchObject({ data: { url: expect.any(String) } });
  });
  it('does not store a failed render or a member changed during render preflight', async () => {
    const f = await fixture(), options = { scope: db.forGym, clock: f.clock, uploadsFor: async () => f.uploads };
    const failed = createWaiversService({ ...options, render: async () => { throw new Error('Render failed'); } });
    await expect(failed.sign(f.ctx, f.input, f.signing)).rejects.toThrow('Render failed');
    const changed = createWaiversService({ ...options, render: async () => {
      // A scoped write here also proves preflight is outside a transaction.
      await db.forGym(f.gymId, tx => tx.update(members).set({ firstName: 'New name' }).where(eq(members.id, f.person.id)));
      return new Uint8Array();
    } });
    await expect(changed.sign(f.ctx, f.input, f.signing)).rejects.toMatchObject({ code: 'conflict' });
    expect((await f.service.listSignatures(f.gymId)).pagination.total).toBe(0);
  });
  it('uses the latest version before kind filtering and preserves pagination', async () => {
    const f = await fixture();
    await f.service.createTemplate(f.ctx, { name: 'Agreement', kind: 'agreement', body: 'Terms' });
    const data = await f.service.listTemplates(f.gymId, { kind: 'agreement', limit: 1, offset: 0 });
    expect(data.data[0]?.name).toBe('Agreement'); expect(data.pagination.total).toBe(1);
    await expect(f.service.createTemplate(f.ctx, { name: f.template.name, kind: 'waiver', body: 'Duplicate' })).rejects.toMatchObject({ code: 'conflict' });
  });
  it('requires a guardian for minors and unknown birthdates, capturing relationship and commitment', async () => {
    const f = await fixture();
    await db.forGym(f.gymId, tx => tx.update(members).set({ dateOfBirth: '2018-03-10' }).where(eq(members.id, f.person.id)));
    await expect(f.service.sign(f.ctx, f.input, f.signing)).rejects.toMatchObject({ code: 'invalid_request' });
    const template = await f.service.createTemplate(f.ctx, { name: 'Membership agreement', kind: 'agreement', body: 'Six month commitment' });
    const signed = await f.service.sign(f.ctx, { ...f.input, templateId: template.id, commitmentEndsOn: '2027-04-24', signer: { kind: 'guardian', name: 'Parent', relationship: 'Mother' } }, f.signing);
    expect(readSnapshot(signed.snapshot, signed.snapshotHash)).toMatchObject({ commitmentEndsOn: '2027-04-24', signer: { kind: 'guardian', relationship: 'Mother' } });
    await db.forGym(f.gymId, tx => tx.update(members).set({ dateOfBirth: null }).where(eq(members.id, f.person.id)));
    const freshImage = await f.service.uploadSignature(f.ctx, f.person.id, png);
    await expect(f.service.sign(f.ctx, { ...f.input, ...freshImage }, f.signing)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects past commitments, a waiver commitment, mismatched digests, and another member image', async () => {
    const f = await fixture(), other = await factory('members', f.gymId, { dateOfBirth: '1990-01-01' });
    await expect(f.service.sign(f.ctx, { ...f.input, commitmentEndsOn: '2027-01-01' }, f.signing)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.service.sign(f.ctx, { ...f.input, signatureImageHash: 'a'.repeat(64) }, f.signing)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.service.sign(f.ctx, { ...f.input, memberId: other.id }, f.signing)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.uploadSignature(f.ctx, other.id, new Uint8Array([1, 2]))).rejects.toMatchObject({ code: 'invalid_request' });
    const agreement = await f.service.createTemplate(f.ctx, { name: 'Past', kind: 'agreement', body: 'Terms' });
    await expect(f.service.sign(f.ctx, { ...f.input, templateId: agreement.id, commitmentEndsOn: '2020-01-01' }, f.signing)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('makes duplicate signing with one image idempotent under concurrency', async () => {
    const f = await fixture(), results = await Promise.all([f.service.sign(f.ctx, f.input, f.signing), f.service.sign(f.ctx, f.input, f.signing)]);
    expect(results[0]).toEqual(results[1]); expect((await f.service.listSignatures(f.gymId, { memberId: f.person.id })).pagination.total).toBe(1);
  });
  it('cannot sign after erasure, or access another gym through references or filters', async () => {
    const f = await fixture(), other = await fixture();
    await expect(f.service.sign(f.ctx, other.input, f.signing)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.sign(f.ctx, { ...f.input, templateId: other.template.id }, f.signing)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.listSignatures(f.gymId, { memberId: other.person.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.listSignatures(f.gymId, { templateId: other.template.id })).rejects.toMatchObject({ code: 'not_found' });
    await db.forGym(f.gymId, tx => tx.update(members).set({ anonymizedAt: f.clock.now() }).where(eq(members.id, f.person.id)));
    await expect(f.service.sign(f.ctx, f.input, f.signing)).rejects.toMatchObject({ code: 'not_found' });
  });
});

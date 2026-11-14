// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, members, uuidv7, waiverSignatures } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createServerRegistry } from '../../core/registry.js';
import { areaContributions } from '../../core/registry-areas.js';
import { FakeJobs } from '../../infra/jobs/index.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoSignaturePng } from '../../demo/seed/waivers-image.js';
import { createWaiversService } from './waivers.js';
import { configureWaivers } from './waivers.routes.js';
import { SIGNATURE_IMAGE_GRACE_MS, sweepSignatureImages } from './signature-images.js';
import { SIGNATURE_IMAGE_SWEEP_JOB } from './waivers.jobs.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng();
async function fixture() {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const member = await factory('members', gymId, { dateOfBirth: '1990-01-01' });
  const clock = new TestClock('2026-11-01T12:00:00Z'), uploads = new FakeUploads(gymId, clock);
  const ctx = { gymId, actor: { kind: 'system' as const } }, options = { scope: db.forGym, clock, uploadsFor: async () => uploads };
  const service = createWaiversService(options);
  const template = await service.createTemplate(ctx, { name: 'Training', kind: 'waiver', body: 'I agree.' });
  const image = await service.uploadSignature(ctx, member.id, png);
  const input = { ...image, memberId: member.id, templateId: template.id, templateVersion: template.version,
    signer: { kind: 'self' as const, name: 'Member' }, consent: true as const };
  const signing = { timezone: 'UTC', ipAddress: '192.0.2.1' };
  const sweep = () => sweepSignatureImages({ gymId, uploads, scope: db.forGym, now: clock.now() });
  return { gymId, member, clock, uploads, ctx, options, service, image, input, signing, sweep };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
it('retains referenced images and recent uploads, and marks only unsigned images older than seven days', async () => {
  const f = await fixture();
  await f.service.sign(f.ctx, f.input, f.signing);
  const abandoned = await f.service.uploadSignature(f.ctx, f.member.id, png);
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS);
  expect(await f.sweep()).toBe(0); // Strictly older than the grace period.
  f.clock.advance(1);
  const recent = await f.service.uploadSignature(f.ctx, f.member.id, png);
  const documentKey = `${f.gymId}/waivers/templates/${uuidv7()}.pdf`;
  await f.uploads.put(documentKey, new Uint8Array([1]), 'application/pdf');
  expect(await f.sweep()).toBe(1);
  expect((await f.uploads.head(abandoned.signatureImageKey))?.deletedAt).toEqual(f.clock.now());
  for (const key of [f.image.signatureImageKey, recent.signatureImageKey, documentKey])
    expect((await f.uploads.head(key))?.deletedAt).toBeUndefined();
  expect(await f.sweep()).toBe(0);
  await expect(f.service.sign(f.ctx, f.input, f.signing)).resolves.toMatchObject({ signatureImageKey: f.image.signatureImageKey });
});
it('protects a signing claim made after the sweep listed an old image, including while its PDF renders', async () => {
  const f = await fixture(), listed = gate(), resumeList = gate(), rendering = gate(), finishRender = gate();
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  const list = f.uploads.list.bind(f.uploads);
  vi.spyOn(f.uploads, 'list').mockImplementationOnce(async prefix => {
    const files = await list(prefix); listed.release(); await resumeList.promise; return files;
  });
  const sweeping = f.sweep(); await listed.promise;
  const service = createWaiversService({ ...f.options, render: async () => {
    rendering.release(); await finishRender.promise; return new Uint8Array();
  } });
  const signing = service.sign(f.ctx, f.input, f.signing); await rendering.promise;
  try {
    resumeList.release(); expect(await sweeping).toBe(0);
    expect((await f.uploads.head(f.image.signatureImageKey))?.deletedAt).toBeUndefined();
  } finally { resumeList.release(); finishRender.release(); }
  await signing;
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  expect(await f.sweep()).toBe(0);
});
it('a committed deletion blocks signing even before storage is marked, and a failed marker retries after restart', async () => {
  const f = await fixture(), marking = gate(), finishMark = gate();
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  vi.spyOn(f.uploads, 'markDeleted').mockImplementationOnce(async () => {
    marking.release(); await finishMark.promise; throw new Error('Storage unavailable');
  });
  const sweeping = f.sweep(); const failedSweep = expect(sweeping).rejects.toThrow('Storage unavailable');
  await marking.promise;
  try {
    expect((await f.uploads.head(f.image.signatureImageKey))?.deletedAt).toBeUndefined();
    await expect(createWaiversService(f.options).sign(f.ctx, f.input, f.signing)).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toEqual([]);
  } finally { finishMark.release(); }
  await failedSweep;
  expect(await f.sweep()).toBe(1);
  const markers = await db.forGym(f.gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, 'waiver.signature_image.deleted')));
  expect(markers).toHaveLength(1);
  expect(markers[0]).toMatchObject({ actorKind: 'system', before: null, after: null });
});
it('keeps marking the other images when one storage marker fails', async () => {
  const f = await fixture(), other = await f.service.uploadSignature(f.ctx, f.member.id, png);
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  const keys = [f.image.signatureImageKey, other.signatureImageKey];
  vi.spyOn(f.uploads, 'markDeleted').mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(f.sweep()).rejects.toThrow('Storage unavailable');
  const marked = async () => (await Promise.all(keys.map(key => f.uploads.head(key)))).filter(info => info?.deletedAt).length;
  expect(await marked()).toBe(1);
  expect(await f.sweep()).toBe(1);
  expect(await marked()).toBe(2);
});
it('marks the old images of a removed member, which no signature can reference', async () => {
  const f = await fixture();
  await db.forGym(f.gymId, tx => tx.delete(members).where(eq(members.id, f.member.id)));
  f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  expect(await f.sweep()).toBe(1);
  expect((await f.uploads.head(f.image.signatureImageKey))?.deletedAt).toEqual(f.clock.now());
});
it('reclaims an abandoned signing claim and refuses a late signature commit', async () => {
  const f = await fixture(), rendering = gate(), finishRender = gate();
  const service = createWaiversService({ ...f.options, render: async () => {
    rendering.release(); await finishRender.promise; return new Uint8Array();
  } });
  const signing = service.sign(f.ctx, f.input, f.signing), rejected = expect(signing).rejects.toMatchObject({ code: 'not_found' });
  await rendering.promise;
  try { f.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1); expect(await f.sweep()).toBe(1); }
  finally { finishRender.release(); }
  await rejected;
  expect(await db.forGym(f.gymId, tx => tx.select().from(waiverSignatures))).toEqual([]);
});
it('the production area registrations run the configured daily sweep only for the job gym', async () => {
  const a = await fixture(), b = await fixture(), jobs = new FakeJobs(a.clock);
  a.clock.advance(SIGNATURE_IMAGE_GRACE_MS + 1);
  configureWaivers({ scope: db.forGym, clock: a.clock, uploadsFor: async gymId => gymId === a.gymId ? a.uploads : b.uploads });
  createServerRegistry(areaContributions).registerJobs(jobs, new Set());
  expect(jobs.schedules.get(SIGNATURE_IMAGE_SWEEP_JOB)).toBe('20 3 * * *');
  expect(jobs.batchJobs.has(SIGNATURE_IMAGE_SWEEP_JOB)).toBe(true);
  await jobs.triggerSchedule(SIGNATURE_IMAGE_SWEEP_JOB, [{ gymId: a.gymId, timezone: 'UTC' }], 'daily');
  expect(await jobs.runNext()).toBe(true);
  expect(jobs.jobs.find(job => job.name === SIGNATURE_IMAGE_SWEEP_JOB)?.status).toBe('completed');
  expect((await a.uploads.head(a.image.signatureImageKey))?.deletedAt).toEqual(a.clock.now());
  expect((await b.uploads.head(b.image.signatureImageKey))?.deletedAt).toBeUndefined();
});

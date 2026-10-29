// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../core/clock.js';
import { FakeUploads, type Uploads } from '../infra/storage/index.js';
import { createWaiversService } from '../areas/waivers/waivers.js';
import { demoSignaturePng } from './seed/waivers-image.js';
import { DemoUploads } from './uploads.js';
import { demoSignatureReservation } from './waiver-signatures.js';

const db = useTestDatabase(), factory = createFactories(db), png = demoSignaturePng();
async function fixture() {
  const gymId = uuidv7(), clock = new TestClock('2026-10-28T12:00:00Z');
  await factory('gyms', gymId);
  const people = await Promise.all([0, 1].map(() => factory('members', gymId)));
  const source = new FakeUploads(gymId, clock), uploads = new DemoUploads(source), put = vi.spyOn(source, 'put');
  const context = { gymId, actor: { kind: 'system' as const } };
  const service = () => createWaiversService({ scope: db.forGym, clock, uploadsFor: async () => uploads });
  const reservations = () => db.forGym(gymId, tx => tx.select().from(auditEvents).where(eq(auditEvents.action, demoSignatureReservation)));
  return { gymId, clock, people, source, uploads, put, context, service, reservations };
}

it('admits only bounded valid waiver PNGs while general visitor uploads remain blocked', async () => {
  const f = await fixture(), member = f.people[0]!;
  const generalUploads: Uploads = f.uploads;
  for (const key of [`${f.gymId}/members/${member.id}/photo.png`, `${f.gymId}/waivers/${member.id}/pdf/${uuidv7()}.pdf`])
    await expect(generalUploads.put(key, png, 'image/png')).rejects.toMatchObject({ code: 'forbidden' });
  await expect(f.uploads.waiverSignature(`${f.gymId}/uploads/${uuidv7()}.png`, png)).rejects.toMatchObject({ code: 'not_found' });
  await expect(f.uploads.waiverSignature(`${f.gymId}/waivers/${member.id}/signatures/${uuidv7()}.png`, new Uint8Array([1])))
    .rejects.toMatchObject({ code: 'invalid_request' });
  await expect(f.service().uploadSignature(f.context, member.id, new Uint8Array(256 * 1024 + 1)))
    .rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.put).not.toHaveBeenCalled(); expect(await f.reservations()).toHaveLength(0);
  const image = await f.service().uploadSignature(f.context, member.id, png);
  expect((await f.source.head(image.signatureImageKey))?.contentType).toBe('image/png');
  expect(await f.reservations()).toHaveLength(1);
});

it('serializes a persistent 64-upload sandbox allowance across members and recreated services', async () => {
  const f = await fixture(), other = await fixture();
  await db.forGym(f.gymId, tx => tx.insert(auditEvents).values(Array.from({ length: 63 }, () => ({
    gymId: f.gymId, actorKind: 'system', action: demoSignatureReservation,
    targetType: 'member', targetId: f.people[0]!.id, occurredAt: f.clock.now(),
  }))));
  const results = await Promise.allSettled([f.people[0]!, f.people[1]!, f.people[0]!]
    .map(member => f.service().uploadSignature(f.context, member.id, png)));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'rate_limited' });
  expect(f.put).toHaveBeenCalledOnce(); expect(await f.reservations()).toHaveLength(64);
  f.clock.advance(86_400_000);
  await expect(f.service().uploadSignature(f.context, f.people[1]!.id, png)).rejects.toMatchObject({ code: 'rate_limited' });
  expect(f.put).toHaveBeenCalledOnce();
  await other.service().uploadSignature(other.context, other.people[0]!.id, png);
  expect(await other.reservations()).toHaveLength(1);
});

it('checks member ownership before storage or admission and retains admissions after a lost storage response', async () => {
  const f = await fixture(), other = await fixture();
  await expect(f.service().uploadSignature(f.context, other.people[0]!.id, png)).rejects.toMatchObject({ code: 'not_found' });
  expect(f.put).not.toHaveBeenCalled(); expect(await f.reservations()).toHaveLength(0);
  const put = f.source.put.bind(f.source);
  f.put.mockImplementationOnce(async (...args) => { await put(...args); throw new Error('Storage response lost'); });
  await expect(f.service().uploadSignature(f.context, f.people[0]!.id, png)).rejects.toThrow('Storage response lost');
  expect(await f.reservations()).toHaveLength(1);
  await f.service().uploadSignature(f.context, f.people[0]!.id, png);
  expect(await f.reservations()).toHaveLength(2); expect(await f.source.list()).toHaveLength(2);
  expect(JSON.stringify(await f.reservations())).not.toMatch(/pngBase64|signatureImageHash|signer/);
});

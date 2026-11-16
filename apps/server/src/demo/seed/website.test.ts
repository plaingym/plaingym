// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { TestClock } from '../../core/clock.js';
import { createSettingsService } from '../../areas/settings/settings.js';
import { createWebsiteService } from '../../modules/website/service.js';
import { FakeUploads } from '../../infra/storage/index.js';
import { demoUploads } from '../uploads.js';
import { websiteSeed } from './website.js';

const db = useTestDatabase(), factory = createFactories(db), clock = new TestClock('2026-11-16T12:00:00Z');
const context = (gymId: string) => ({ gymId, timezone: 'UTC', enabledModules: new Set<string>() });

it('seeds bounded, gym-owned images once while preserving the publish switch and visitor upload restrictions', async () => {
  const gymId = uuidv7(), other = uuidv7();
  await factory('gyms', gymId); await factory('gyms', other);
  const uploads = new FakeUploads(gymId, clock);
  const options = { scope: db.forGym, clock, uploadsFor: async () => uploads };
  const service = createWebsiteService(options), step = websiteSeed(options);
  await step.run(context(gymId));
  const seeded = await service.settings(gymId);
  expect(seeded).toMatchObject({ logo: true, photos: [{ alt: 'Sunlit training mats in a sample martial arts academy' }] });
  expect(seeded.logoVersion).toMatch(/^[a-f0-9]{12}$/);
  const files = await uploads.list();
  expect(files).toHaveLength(2);
  for (const file of files) {
    expect(file.key).toMatch(new RegExp(`^${gymId}/website/(logo|photos)/`));
    expect(file.size).toBeLessThanOrEqual(512 * 1024);
    expect(file.deletedAt).toBeUndefined();
    const bytes = new Uint8Array(await new Response(await uploads.get(file.key)).arrayBuffer());
    expect([...bytes.slice(0, file.contentType === 'image/png' ? 8 : 3)]).toEqual(
      file.contentType === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255]);
  }
  await step.run(context(gymId));
  expect(await service.settings(gymId)).toEqual(seeded);
  expect(await uploads.list()).toEqual(files);
  expect(await service.settings(other)).toMatchObject({ logo: false, photos: [] });
  await expect(service.photo(other, seeded.photos[0]!.id)).rejects.toMatchObject({ code: 'not_found' });
  expect((await createSettingsService(options).get(gymId)).websiteEnabled).toBe(false);
  await expect(demoUploads(uploads).put(`${gymId}/website/logo/visitor.png`, new Uint8Array([1]), 'image/png'))
    .rejects.toMatchObject({ code: 'forbidden' });
});

it('resumes after a failed logo upload without duplicating the completed photo or replacing edited content', async () => {
  const gymId = uuidv7(); await factory('gyms', gymId);
  const uploads = new FakeUploads(gymId, clock), put = uploads.put.bind(uploads);
  const spy = vi.spyOn(uploads, 'put').mockImplementation(async (key, body, contentType) => {
    if (key.includes('/logo/')) throw new Error('Temporary storage failure');
    return put(key, body, contentType);
  });
  const options = { scope: db.forGym, clock, uploadsFor: async () => uploads };
  const service = createWebsiteService(options), step = websiteSeed(options);
  await expect(step.run(context(gymId))).rejects.toThrow('Temporary storage failure');
  const partial = await service.settings(gymId);
  expect(partial.photos).toHaveLength(1); expect(partial.logo).toBe(false);
  spy.mockRestore();
  await service.update({ gymId, actor: { kind: 'system' } }, { revision: partial.revision, tagline: 'Keep my text', about: null,
    phone: null, email: null, primaryColor: null, photos: partial.photos });
  await step.run(context(gymId));
  expect(await service.settings(gymId)).toMatchObject({ logo: true, photos: partial.photos, tagline: 'Keep my text' });
  expect(await uploads.list()).toHaveLength(2);
});

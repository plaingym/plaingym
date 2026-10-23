// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { gyms, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { parseEncryptionKey } from '../../core/secrets.js';
import { createSettingsService } from '../settings/settings.js';
import { createSetupService } from './setup.js';

const database = useTestDatabase(), factory = createFactories(database);

it.each([null, '#2563eb'])('keeps setup branding readable by settings with color %s', async (primaryColor) => {
  const gymId = uuidv7();
  const gym = await factory('gyms', gymId);
  const owner = await factory('authUser', gymId);
  await database.forGym(gymId, (tx) => tx.update(gyms).set({ settings: {
    setup: { ownerId: owner.id, completedSteps: [0, 1], completed: false },
  } }).where(eq(gyms.id, gymId)));
  const service = createSetupService({ key: parseEncryptionKey('ab'.repeat(32)), origin: 'https://gym.example.test', scope: database.forGym });
  const result = await service.gym({ gymId, actor: { kind: 'user', userId: owner.id } }, {
    name: 'Academy', timezone: 'UTC', currency: 'USD', address: {},
    branding: { logoKey: null, primaryColor }, revision: gym.revision,
  });
  expect(result.branding).toEqual({ logoKey: null, primaryColor });
  const settings = await createSettingsService({ scope: database.forGym }).get(gymId);
  expect(settings.branding).toEqual(primaryColor === null ? { logoKey: null } : { logoKey: null, primaryColor });
});

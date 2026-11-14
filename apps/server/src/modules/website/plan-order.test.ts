// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import '@hono/zod-openapi';
import { uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { createWebsiteService } from './service.js';

const db = useTestDatabase(), factory = createFactories(db);
it('lists active plans by name and ID, matching join rather than price', async () => {
  const gymId = uuidv7(), otherGymId = uuidv7();
  await factory('gyms', gymId, { currency: 'USD', websiteEnabled: true });
  await factory('gyms', otherGymId, { currency: 'EUR' });
  const advanced = await factory('plans', gymId, { name: 'Advanced', amountCents: 50_000 });
  const first = await factory('plans', gymId, { name: 'Basics', amountCents: 10_000 });
  const second = await factory('plans', gymId, { name: 'Basics', amountCents: 5_000 });
  await factory('plans', gymId, { name: 'Archived', active: false });
  await factory('plans', otherGymId, { name: 'Another gym', currency: 'EUR' });
  const site = await createWebsiteService({ scope: db.forGym }).site(gymId, ['plans']);
  expect(site.plans.map(plan => plan.id)).toEqual([advanced.id, ...[first.id, second.id].sort()]);
});

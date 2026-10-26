// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { authUser, uuidv7 } from '@plaingym/db';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { createFactories } from '@plaingym/db/testing/factories';
import { inArray } from 'drizzle-orm';
import { authConfig } from './config.js';
import { createAccountService } from './accounts.js';

const db = useTestDatabase(), factory = createFactories(db);
const accounts = createAccountService(authConfig({ AUTH_SECRET: 'account-service-test-secret-at-least-32-characters' }, false), () => db.system.db);

it('lists only the requested roles of the requested gym', async () => {
  const gymA = uuidv7(), gymB = uuidv7();
  await factory('gyms', gymA); await factory('gyms', gymB);
  const owner = await factory('staffRoles', gymA, { role: 'owner' }), admin = await factory('staffRoles', gymA, { role: 'admin' });
  await factory('staffRoles', gymA, { role: 'coach' }); await factory('staffRoles', gymB, { role: 'admin' });
  const expected = (await db.system.db.select({ email: authUser.email }).from(authUser).where(inArray(authUser.id, [owner.userId, admin.userId])))
    .map((row) => row.email).sort();
  expect((await accounts.staffEmails(gymA, ['owner', 'admin'])).sort()).toEqual(expected);
  expect(await accounts.staffEmails(gymA, [])).toEqual([]);
});

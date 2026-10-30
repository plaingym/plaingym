// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { useTestDatabase } from '../../../packages/db/src/testing/database.js';
import { assertCatalog } from '../../../packages/db/src/security/catalog.js';
const database = useTestDatabase();
it('validates the complete migrated catalog as the restricted app role', async () => {
  expect(await assertCatalog(database.app.sql)).toEqual({ tableCount: 56, tenantTableCount: 45 });
});

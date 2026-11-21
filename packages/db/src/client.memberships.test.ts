// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { closeDatabase, initializeDatabase } from './client.js';
import { privilegedMemberships } from './security/memberships.js';
import { useTestDatabase } from './testing/database.js';

vi.mock('./security/memberships.js', () => ({ privilegedMemberships: vi.fn() }));

const database = useTestDatabase();

it('refuses a privileged membership at startup and allows a later retry', async () => {
  const memberships = vi.mocked(privilegedMemberships);
  try {
    memberships.mockResolvedValue(['pg_monitor']);
    await expect(initializeDatabase(database.appUrl)).rejects.toThrow('app is a member of privileged role pg_monitor');

    memberships.mockResolvedValue([]);
    await expect(initializeDatabase(database.appUrl)).resolves.toBeUndefined();
  } finally {
    await closeDatabase();
  }
});

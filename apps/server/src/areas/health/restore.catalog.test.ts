// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
// Test-only maintenance access builds a hostile snapshot and cleans up its schemas.
// eslint-disable-next-line no-restricted-imports
import { openConnection } from '@plaingym/db/client';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

const f = useRestoreFixture();

it('keeps a restored snapshot with a planted owner view gated before rekey or upload activation', async () => {
  const source = openConnection(f.source.maintenanceUrl, 1);
  const target = openConnection(f.target.maintenanceUrl, 1);
  const originalDump = f.sourceMaintenance.dump;
  try {
    await source.sql`create schema app authorization maintenance`;
    await source.sql`grant usage on schema app to app`;
    await source.sql`create view app.households as select * from public.households`;
    await source.sql`grant select on app.households to app`;
    // A bucket writer can supply an archive with schemas our own dumps do not include.
    f.sourceMaintenance.dump = () => f.sourceMaintenance.tool('pg_dump', [
      '--format=custom', '--no-owner', '--schema=public', '--schema=drizzle', '--schema=app',
    ]);
    const snapshot = await f.backup().snapshot();
    const phases: string[] = [];
    await expect(f.restore(phase => { phases.push(phase); }).restore(snapshot.id, f.identity)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringContaining('app: unexpected usable schema') }),
    });
    expect(phases).toContain('database_restored');
    expect(phases).not.toContain('migrated');
    expect(phases).not.toContain('secret_field');
    expect(await f.gate().isClosed()).toBe(true);
    expect(await new Response(await f.restoredUploads().get(f.gymId + '/sentinel')).text()).toBe('live upload sentinel');
  } finally {
    f.sourceMaintenance.dump = originalDump;
    await source.sql`drop schema if exists app cascade`;
    await target.sql`drop schema if exists app cascade`;
    await source.close(); await target.close();
  }
});

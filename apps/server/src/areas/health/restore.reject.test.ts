// SPDX-License-Identifier: AGPL-3.0-only
import '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { gyms } from '@plaingym/db';
import { generateIdentity } from '../../infra/age/index.js';
import { snapshotPrefix } from './backups.format.js';
import { useTestDatabase } from '@plaingym/db/testing/database';
import { useRestoreFixture } from './restore.fixture.test-helper.js';

// Every test tampers with the shared snapshot's stored objects; the fixture puts them back after each test.
const f = useRestoreFixture({ source: useTestDatabase(), target: useTestDatabase() }, { shared: true });
const { gymId } = f;
let base: Awaited<ReturnType<ReturnType<typeof f.backup>['snapshot']>>;
beforeAll(async () => { base = await f.prepare(() => f.backup().snapshot()); });

describe('install restore of a damaged snapshot', () => {
  it.each(['wrong-key', 'truncated-dump', 'corrupt-blob', 'reordered-dump', 'missing-reference', 'substituted-manifest'])(
    'rejects %s before changing live rows or uploads', async (mode) => {
      const snapshot = base;
      const prefix = 'backups/' + snapshotPrefix(snapshot.id);
      if (mode === 'truncated-dump' || mode === 'reordered-dump') {
        const object = f.server.objects.get(prefix + 'database.age')!;
        const bytes = Buffer.from(object.bytes);
        if (mode === 'truncated-dump') object.bytes = bytes.subarray(0, -1);
        else { const offset = Math.floor(bytes.length / 2); bytes.copyWithin(offset, offset + 32); object.bytes = bytes; }
      } else if (mode === 'corrupt-blob') {
        const object = f.server.objects.get('backups/' + snapshot.uploads[0]!.blob)!;
        object.bytes = Buffer.from(object.bytes); object.bytes[object.bytes.length - 1]! ^= 1;
      } else if (mode === 'missing-reference') f.server.objects.delete(prefix + 'references.json');
      else if (mode === 'substituted-manifest') {
        const second = await f.backup().snapshot();
        f.server.objects.set(prefix + 'manifest.age', f.server.objects.get('backups/' + snapshotPrefix(second.id) + 'manifest.age')!);
      }
      const before = await f.target.forSystem((tx) => tx.select({ id: gyms.id, secret: gyms.qrKey }).from(gyms));
      await expect(f.restore().restore(snapshot.id, mode === 'wrong-key' ? await generateIdentity() : f.identity)).rejects.toThrow();
      expect(await f.target.forSystem((tx) => tx.select({ id: gyms.id, secret: gyms.qrKey }).from(gyms))).toEqual(before);
      expect(await new Response(await f.restoredUploads().get(gymId + '/sentinel')).text()).toBe('live upload sentinel');
      expect(await f.gate().isClosed()).toBe(false);
    });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signReferences, verifyReferences, type Snapshot } from './backups.format.js';

const key = Buffer.alloc(32, 7), id = '019a08bf-1234-7000-8000-000000000001';
const metadata = { sha256: 'a'.repeat(64), size: 123 };
const snapshot: Snapshot = { version: 1, id, kind: 'hourly', startedAt: '2026-11-13T00:00:00Z',
  database: metadata, manifest: metadata,
  uploads: [{ blob: 'blobs/' + 'b'.repeat(64) + '.age', protectedHash: 'c'.repeat(64), encrypted: metadata }] };
// Model a newer writer independently; the old signer must continue rejecting extensions.
function signed(value: unknown) {
  const payload = JSON.stringify(value);
  return { payload, mac: createHmac('sha256', key).update('plaingym-backup-references-v1\n').update(payload).digest('hex') };
}
const extended = {
  snapshot: { ...snapshot, future: true },
  database: { ...snapshot, database: { ...metadata, future: true } },
  manifest: { ...snapshot, manifest: { ...metadata, future: true } },
  upload: { ...snapshot, uploads: [{ ...snapshot.uploads[0]!, future: true }] },
  encrypted: { ...snapshot, uploads: [{ ...snapshot.uploads[0]!, encrypted: { ...metadata, future: true } }] },
};
describe('signed backup reference compatibility', () => {
  it.each(Object.entries(extended))('reads authenticated extensions in %s while keeping signing strict', (_name, value) => {
    expect(verifyReferences(signed(value), key, id)).toEqual(snapshot);
    expect(() => signReferences(value, key)).toThrow();
  });
  it('authenticates unknown fields before stripping them', () => {
    const envelope = signed(extended.snapshot);
    envelope.payload = JSON.stringify({ ...extended.snapshot, future: false });
    expect(() => verifyReferences(envelope, key, id)).toThrow('Invalid reference authentication');
  });
  it('still rejects invalid known fields and a different snapshot ID', () => {
    expect(() => verifyReferences(signed({ ...extended.snapshot, database: { ...metadata, size: -1 } }), key, id)).toThrow();
    expect(() => verifyReferences(signed(extended.snapshot), key, '019a08bf-1234-7000-8000-000000000002')).toThrow('another snapshot');
  });
});

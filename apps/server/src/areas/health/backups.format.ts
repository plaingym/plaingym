// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BackupObjectStore } from '../../infra/storage/index.js';
import { bytesStream } from './backups.files.js';

export const backupKindSchema = z.enum(['hourly', 'nightly', 'weekly', 'pre_upgrade', 'manual']);
export type BackupKind = z.infer<typeof backupKindSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.uuid();
const size = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const objectSchema = z.strictObject({ sha256: hash, size });
export const uploadReferenceSchema = z.strictObject({
  gymId: id, key: z.string().min(1), blob: z.string().regex(/^blobs\/[a-f0-9]{64}[.]age$/),
  recipient: z.string().regex(/^age1[0-9a-z]+$/), contentType: z.string(), createdAt: z.iso.datetime(), plaintext: objectSchema, encrypted: objectSchema,
});
export type UploadReference = z.infer<typeof uploadReferenceSchema>;
const publicReferenceSchema = z.strictObject({
  blob: z.string().regex(/^blobs\/[a-f0-9]{64}[.]age$/),
  protectedHash: hash, encrypted: objectSchema,
});
export function protectedName(blobKey: Buffer, uploadKey: string): string {
  return createHmac('sha256', blobKey).update('plaingym-upload-reference-v1\n').update(uploadKey).digest('hex');
}
export function publicReferences(uploads: readonly UploadReference[], blobKey: Buffer) {
  return uploads.map((upload) => ({ blob: upload.blob, protectedHash: protectedName(blobKey, upload.key), encrypted: upload.encrypted }));
}
export const snapshotSchema = z.strictObject({
  version: z.literal(1), id, kind: backupKindSchema, startedAt: z.iso.datetime(),
  database: objectSchema, manifest: objectSchema, uploads: z.array(publicReferenceSchema),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const manifestSchema = z.strictObject({
  version: z.literal(1), id, kind: backupKindSchema, startedAt: z.iso.datetime(),
  database: z.strictObject({ encrypted: objectSchema, plaintext: objectSchema }),
  recovery: z.strictObject({ appEncryptionKey: z.string().regex(/^[a-f0-9]{64}$/), blobKey: z.string().regex(/^[a-f0-9]{64}$/) }),
  uploads: z.array(uploadReferenceSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;
export const snapshotPrefix = (id: string): string => 'snapshots/' + z.uuid().parse(id) + '/';
export function blobName(blobKey: Buffer, gymId: string, key: string, digest: string, recipient: string): string {
  if (blobKey.length !== 32) throw new Error('Invalid backup blob key');
  return 'blobs/' + createHmac('sha256', blobKey).update(JSON.stringify([gymId, key, digest, recipient])).digest('hex') + '.age';
}
function mac(key: Buffer, payload: string): Buffer {
  return createHmac('sha256', key).update('plaingym-backup-references-v1\n').update(payload).digest();
}
/** The complete reference list is MACed and bound to its snapshot, including dump and manifest hashes. */
export function signReferences(snapshot: Snapshot, key: Buffer): string {
  const payload = JSON.stringify(snapshotSchema.parse(snapshot));
  return JSON.stringify({ payload, mac: mac(key, payload).toString('hex') });
}
export function verifyReferences(value: unknown, key: Buffer, expectedId: string): Snapshot {
  const envelope = z.strictObject({ payload: z.string(), mac: hash }).parse(value);
  if (!timingSafeEqual(mac(key, envelope.payload), Buffer.from(envelope.mac, 'hex'))) throw new Error('Invalid reference authentication');
  const snapshot = snapshotSchema.parse(JSON.parse(envelope.payload));
  if (snapshot.id !== expectedId) throw new Error('Reference list belongs to another snapshot');
  if (new Set(snapshot.uploads.map((u) => u.blob)).size !== snapshot.uploads.length ||
      new Set(snapshot.uploads.map((u) => u.protectedHash)).size !== snapshot.uploads.length)
    throw new Error('Duplicate upload references');
  return snapshot;
}
export function validateReferences(uploads: readonly UploadReference[], key: Buffer): void {
  const names = new Set<string>();
  for (const upload of uploads) {
    if (!upload.key.startsWith(upload.gymId + '/') || upload.key.includes('\\') ||
        upload.key.split('/').some((part) => !part || part === '.' || part === '..') ||
        names.has(upload.key) || blobName(key, upload.gymId, upload.key, upload.plaintext.sha256, upload.recipient) !== upload.blob)
      throw new Error('Invalid upload reference');
    names.add(upload.key);
  }
}
export async function readReferences(store: BackupObjectStore, key: string): Promise<unknown> {
  const body = await store.getObject(key);
  if (!body) throw new Error('Missing snapshot reference list; pruning stopped');
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const chunk of body) {
    length += chunk.length;
    if (length > 16 * 1024 * 1024) throw new Error('Reference list exceeds size limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export const referenceStream = (snapshot: Snapshot, key: Buffer): ReadableStream<Uint8Array> => bytesStream(signReferences(snapshot, key));

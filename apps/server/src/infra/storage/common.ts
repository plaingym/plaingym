// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { ObjectInfo, UploadBody, UploadInfo, Uploads } from './index.js';

export function validKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('\\') ||
    key.split('/').some((part) => part === '.' || part === '..') ||
    [...key].some((character) => { const code = character.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159); })) throw new Error('Invalid object key');
}
export function gymKey(gymId: string, key: string): void {
  validKey(key);
  if (!key.startsWith(gymId + '/') || key === gymId + '/') throw new Error('Key belongs to another gym');
}
export function validGym(gymId: string): void {
  validKey(gymId);
  if (gymId.includes('/')) throw new Error('Invalid gym ID');
}
export function digest(key: string): string { return createHash('sha256').update(key).digest('hex'); }
export function lifetime(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800) throw new Error('Invalid URL lifetime');
}
export function cutoff(before: Date): void {
  if (!Number.isFinite(before.getTime())) throw new Error('Invalid sweep cutoff');
}
export function bodyStream(body: UploadBody): ReadableStream<Uint8Array> {
  if (!(body instanceof Uint8Array)) return body;
  const bytes = body.slice();
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
export interface UploadRecord { key: string; info?: UploadInfo; swept?: boolean }
export function encodeRecord(record: UploadRecord): string { return JSON.stringify(record); }
export function decodeRecord(json: string): UploadRecord {
  const record = JSON.parse(json) as UploadRecord;
  if (record.info) record.info = {
    ...record.info, createdAt: new Date(record.info.createdAt),
    ...(record.info.deletedAt ? { deletedAt: new Date(record.info.deletedAt) } : {}),
  };
  return record;
}
export interface UploadBackend {
  reserve(key: string): Promise<void>;
  record(key: string): Promise<UploadRecord | null>;
  save(record: UploadRecord): Promise<void>;
  records(): Promise<readonly UploadRecord[]>;
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<ObjectInfo>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  remove(key: string): Promise<void>;
  signedUrl(key: string, seconds: number): Promise<string>;
}

/** Durable reservations outlive blobs, so deleting a blob never releases its key. */
export class DurableUploads implements Uploads {
  constructor(readonly gymId: string, protected readonly backend: UploadBackend, readonly clock: Clock) { validGym(gymId); }
  async put(key: string, body: UploadBody, contentType: string): Promise<UploadInfo> {
    assertNoTransaction('storage.put'); gymKey(this.gymId, key);
    await this.backend.reserve(key);
    const info = { ...await this.backend.put(key, bodyStream(body), contentType), key };
    await this.backend.save({ key, info });
    return info;
  }
  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.get'); gymKey(this.gymId, key);
    const record = await this.backend.record(key);
    return record?.info && !record.swept ? this.backend.get(key) : null;
  }
  async head(key: string): Promise<UploadInfo | null> {
    assertNoTransaction('storage.head'); gymKey(this.gymId, key);
    const record = await this.backend.record(key);
    return record?.info && !record.swept ? record.info : null;
  }
  async list(prefix = this.gymId + '/'): Promise<readonly UploadInfo[]> {
    assertNoTransaction('storage.list');
    validKey(prefix);
    if (!prefix.startsWith(this.gymId + '/')) throw new Error('Prefix belongs to another gym');
    return (await this.backend.records()).flatMap((record) => {
      gymKey(this.gymId, record.key);
      return record.info && !record.swept && record.key.startsWith(prefix) ? [record.info] : [];
    }).sort((a, b) => a.key.localeCompare(b.key));
  }
  async signedUrl(key: string, seconds: number): Promise<string | null> {
    assertNoTransaction('storage.signedUrl'); gymKey(this.gymId, key); lifetime(seconds);
    return await this.head(key) ? this.backend.signedUrl(key, seconds) : null;
  }
  async markDeleted(key: string): Promise<void> {
    assertNoTransaction('storage.markDeleted'); gymKey(this.gymId, key);
    const record = await this.backend.record(key);
    if (record?.info && !record.swept && !record.info.deletedAt)
      await this.backend.save({ ...record, info: { ...record.info, deletedAt: this.clock.now() } });
  }
  async sweep(options: { before: Date; protectedKeys?: ReadonlySet<string> }): Promise<readonly string[]> {
    assertNoTransaction('storage.sweep'); cutoff(options.before);
    const removed: string[] = [];
    for (const record of await this.backend.records()) {
      gymKey(this.gymId, record.key);
      if (record.info?.deletedAt && record.info.deletedAt <= options.before && !options.protectedKeys?.has(record.key)) {
        // Save the tombstone first; a later sweep retries any interrupted blob removal.
        await this.backend.save({ ...record, swept: true });
        await this.backend.remove(record.key);
        if (!record.swept) removed.push(record.key);
      }
    }
    return removed.sort();
  }
}

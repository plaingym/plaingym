// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';

export interface ObjectInfo {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
  readonly etag: string;
  readonly createdAt: Date;
}
export interface UploadInfo extends ObjectInfo {
  readonly deletedAt?: Date;
}
export type UploadBody = Uint8Array | ReadableStream<Uint8Array>;
export interface Uploads {
  /** Keys include the gym prefix and are immutable, including after markDeleted. */
  put(key: string, body: UploadBody, contentType: string): Promise<UploadInfo>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  head(key: string): Promise<UploadInfo | null>;
  list(prefix?: string): Promise<readonly UploadInfo[]>;
  signedUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  markDeleted(key: string): Promise<void>;
  /** The caller holds the backup lock. Protected keys cannot be swept. */
  sweep(options: { before: Date; protectedKeys?: ReadonlySet<string> }): Promise<readonly string[]>;
}
export interface PutObjectOptions {
  readonly contentType?: string;
  readonly partSize?: number;
  readonly signal?: AbortSignal;
}
export interface BackupObjectStore {
  /** Multipart completion is atomic; any failure aborts the upload. */
  putObject(key: string, body: ReadableStream<Uint8Array>, options?: PutObjectOptions): Promise<ObjectInfo>;
  getObject(key: string): Promise<ReadableStream<Uint8Array> | null>;
  headObject(key: string): Promise<ObjectInfo | null>;
  listObjects(prefix: string): Promise<readonly ObjectInfo[]>;
  deleteObject(key: string): Promise<void>;
}

function validKey(key: string): void {
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.split('/').some((part) => part === '..' || part === '.') ||
    [...key].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error('Invalid object key');
}
function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = bytes.slice();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}
function concat(parts: readonly Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function info(key: string, bytes: Uint8Array, contentType: string, clock: Clock): ObjectInfo {
  return {
    key,
    size: bytes.length,
    contentType,
    createdAt: clock.now(),
    etag: createHash('sha256').update(bytes).digest('hex'),
  };
}

export class FakeUploads implements Uploads {
  readonly #objects = new Map<string, { bytes: Uint8Array; info: UploadInfo }>();
  readonly #reserved = new Set<string>();
  constructor(
    readonly gymId: string,
    readonly clock: Clock = systemClock,
  ) {}
  #key(key: string): void {
    validKey(key);
    if (!key.startsWith(this.gymId + '/') || key === this.gymId + '/')
      throw new Error('Key belongs to another gym');
  }
  async put(key: string, body: UploadBody, contentType: string): Promise<UploadInfo> {
    assertNoTransaction('storage.put');
    this.#key(key);
    if (this.#reserved.has(key)) throw new Error('Upload keys are immutable');
    this.#reserved.add(key);
    try {
      const bytes =
        body instanceof Uint8Array ? body.slice() : new Uint8Array(await new Response(body).arrayBuffer());
      const metadata = info(key, bytes, contentType, this.clock);
      this.#objects.set(key, { bytes, info: metadata });
      return structuredClone(metadata);
    } catch (error) {
      this.#reserved.delete(key);
      throw error;
    }
  }
  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.get');
    this.#key(key);
    const object = this.#objects.get(key);
    return object ? bytesStream(object.bytes) : null;
  }
  async head(key: string): Promise<UploadInfo | null> {
    assertNoTransaction('storage.head');
    this.#key(key);
    return structuredClone(this.#objects.get(key)?.info ?? null);
  }
  async list(prefix = this.gymId + '/'): Promise<readonly UploadInfo[]> {
    assertNoTransaction('storage.list');
    validKey(prefix);
    if (!prefix.startsWith(this.gymId + '/')) throw new Error('Prefix belongs to another gym');
    return structuredClone(
      [...this.#objects.values()]
        .filter((object) => object.info.key.startsWith(prefix))
        .map((object) => object.info)
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
  async signedUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    assertNoTransaction('storage.signedUrl');
    this.#key(key);
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds <= 0)
      throw new Error('Invalid URL lifetime');
    if (!this.#objects.has(key)) return null;
    return `https://uploads.invalid/${encodeURIComponent(key)}?expires=${this.clock.now().getTime() + expiresInSeconds * 1000}`;
  }
  async markDeleted(key: string): Promise<void> {
    assertNoTransaction('storage.markDeleted');
    this.#key(key);
    const object = this.#objects.get(key);
    if (object && !object.info.deletedAt) object.info = { ...object.info, deletedAt: this.clock.now() };
  }
  async sweep(options: { before: Date; protectedKeys?: ReadonlySet<string> }): Promise<readonly string[]> {
    assertNoTransaction('storage.sweep');
    if (!Number.isFinite(options.before.getTime())) throw new Error('Invalid sweep cutoff');
    const removed: string[] = [];
    for (const [key, object] of this.#objects) {
      if (
        object.info.deletedAt &&
        object.info.deletedAt <= options.before &&
        !options.protectedKeys?.has(key)
      ) {
        this.#objects.delete(key);
        removed.push(key);
      }
    }
    return removed.sort();
  }
}

export class FakeBackupObjectStore implements BackupObjectStore {
  readonly #objects = new Map<string, { bytes: Uint8Array; info: ObjectInfo }>();
  readonly #active = new Set<string>();
  readonly #aborted: string[] = [];
  readonly #parts = new Map<string, number[]>();
  #failurePart: number | undefined;
  constructor(readonly clock: Clock = systemClock) {}
  get activeUploads(): number {
    return this.#active.size;
  }
  get abortedUploads(): readonly string[] {
    return [...this.#aborted];
  }
  uploadedPartSizes(key: string): readonly number[] {
    return [...(this.#parts.get(key) ?? [])];
  }
  failAtPart(part: number): void {
    if (!Number.isSafeInteger(part) || part < 1) throw new Error('Invalid part number');
    this.#failurePart = part;
  }
  async putObject(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: PutObjectOptions = {},
  ): Promise<ObjectInfo> {
    assertNoTransaction('storage.putObject');
    validKey(key);
    const partSize = options.partSize ?? 5 * 1024 * 1024;
    if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > 64 * 1024 * 1024) throw new Error('Invalid part size');
    if (this.#active.has(key)) throw new Error('Upload already in progress');
    const reader = body.getReader();
    this.#active.add(key);
    const parts: Uint8Array[] = [];
    let pending = new Uint8Array(partSize);
    let pendingSize = 0;
    let total = 0;
    const failurePart = this.#failurePart;
    this.#failurePart = undefined;
    const signal = options.signal;
    const abort = () => {
      void reader.cancel(signal?.reason).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort, { once: true });
    const flush = () => {
      if (failurePart === parts.length + 1) throw new Error('Simulated multipart failure');
      parts.push(pending.slice(0, pendingSize));
      total += pendingSize;
      pending = new Uint8Array(partSize);
      pendingSize = 0;
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        const result = await reader.read();
        signal?.throwIfAborted();
        if (result.done) break;
        let offset = 0;
        while (offset < result.value.length) {
          const length = Math.min(partSize - pendingSize, result.value.length - offset);
          pending.set(result.value.subarray(offset, offset + length), pendingSize);
          offset += length;
          pendingSize += length;
          if (pendingSize === partSize) flush();
        }
      }
      if (pendingSize > 0) flush();
      const bytes = concat(parts, total);
      const metadata = info(key, bytes, options.contentType ?? 'application/octet-stream', this.clock);
      this.#objects.set(key, { bytes, info: metadata });
      this.#parts.set(
        key,
        parts.map((part) => part.length),
      );
      return structuredClone(metadata);
    } catch (error) {
      this.#aborted.push(key);
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
      reader.releaseLock();
      this.#active.delete(key);
    }
  }
  async getObject(key: string): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.getObject');
    validKey(key);
    const object = this.#objects.get(key);
    return object ? bytesStream(object.bytes) : null;
  }
  async headObject(key: string): Promise<ObjectInfo | null> {
    assertNoTransaction('storage.headObject');
    validKey(key);
    return structuredClone(this.#objects.get(key)?.info ?? null);
  }
  async listObjects(prefix: string): Promise<readonly ObjectInfo[]> {
    assertNoTransaction('storage.listObjects');
    return structuredClone(
      [...this.#objects.values()]
        .filter((object) => object.info.key.startsWith(prefix))
        .map((object) => object.info)
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  }
  async deleteObject(key: string): Promise<void> {
    assertNoTransaction('storage.deleteObject');
    validKey(key);
    this.#objects.delete(key);
  }
}

export { LocalUploads } from './local.js';
export type { LocalUploadsOptions } from './local.js';
export { S3BackupObjectStore, S3Uploads, createS3Client } from './s3.js';
export type { S3StoreOptions } from './s3.js';

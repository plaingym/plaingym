// SPDX-License-Identifier: AGPL-3.0-only
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import { decodeRecord, digest, DurableUploads, encodeRecord, validGym, validKey } from './common.js';
import type { UploadBackend, UploadRecord } from './common.js';
import type { BackupObjectStore, ObjectInfo, PutObjectOptions } from './index.js';

export function createS3Client(config: S3ClientConfig): S3Client {
  return new S3Client({ region: 'auto', forcePathStyle: true, ...config,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}
export interface S3StoreOptions {
  readonly client: S3Client;
  readonly bucket: string;
  readonly clock?: Clock;
}
function notFound(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value.$metadata?.httpStatusCode === 404 || value.name === 'NoSuchKey' || value.name === 'NotFound';
}
function precondition(error: unknown): boolean {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412;
}

export class S3BackupObjectStore implements BackupObjectStore {
  readonly clock: Clock;
  constructor(readonly options: S3StoreOptions) {
    if (!options.bucket) throw new Error('S3 bucket is required');
    this.clock = options.clock ?? systemClock;
  }
  async putObject(key: string, body: ReadableStream<Uint8Array>, options: PutObjectOptions = {}): Promise<ObjectInfo> {
    assertNoTransaction('storage.putObject'); validKey(key);
    const partSize = options.partSize ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(partSize) || partSize < 5 * 1024 * 1024 || partSize > 64 * 1024 * 1024)
      throw new Error('S3 part size must be between 5 and 64 MiB');
    options.signal?.throwIfAborted();
    const { client, bucket: Bucket } = this.options;
    const reader = body.getReader();
    let uploadId: string | undefined;
    const parts: { ETag: string; PartNumber: number }[] = [];
    let buffer = new Uint8Array(partSize); let pending = 0;
    const signal = options.signal;
    const requestOptions = signal ? { abortSignal: signal } : {};
    const abortRead = () => { void reader.cancel(signal?.reason).catch(() => undefined); };
    signal?.addEventListener('abort', abortRead, { once: true });
    const flush = async () => {
      signal?.throwIfAborted();
      if (parts.length >= 10000) throw new Error('S3 multipart part limit exceeded');
      const PartNumber = parts.length + 1;
      const result = await client.send(new UploadPartCommand({
        Bucket, Key: key, UploadId: uploadId, PartNumber, Body: buffer.subarray(0, pending), ContentLength: pending,
      }), requestOptions);
      if (!result.ETag) throw new Error('S3 part response has no ETag');
      parts.push({ ETag: result.ETag, PartNumber }); pending = 0;
      // Each send finishes before the buffer is reused: only one part is in flight.
      buffer = new Uint8Array(partSize);
    };
    try {
      // Learn the upload ID before observing cancellation, so it can always be aborted.
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket, Key: key, ContentType: options.contentType ?? 'application/octet-stream',
      }));
      uploadId = created.UploadId;
      if (!uploadId) throw new Error('S3 response has no upload ID');
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        signal?.throwIfAborted();
        if (chunk.done) break;
        let offset = 0;
        while (offset < chunk.value.length) {
          const count = Math.min(partSize - pending, chunk.value.length - offset);
          buffer.set(chunk.value.subarray(offset, offset + count), pending);
          offset += count; pending += count;
          if (pending === partSize) await flush();
        }
      }
      if (pending || parts.length === 0) await flush();
      signal?.throwIfAborted();
      await client.send(new CompleteMultipartUploadCommand({
        Bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
      }), requestOptions);
      uploadId = undefined;
      const metadata = await this.headObject(key);
      if (!metadata) throw new Error('Completed S3 object is missing');
      return metadata;
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      if (uploadId) {
        try {
          // Cleanup must not inherit an already-aborted signal.
          await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'S3 multipart upload and abort failed', { cause: cleanupError });
        }
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', abortRead); reader.releaseLock();
    }
  }
  async getObject(key: string): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.getObject'); validKey(key);
    try {
      const response = await this.options.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
      return response.Body?.transformToWebStream() ?? null;
    } catch (error) { if (notFound(error)) return null; throw error; }
  }
  async headObject(key: string): Promise<ObjectInfo | null> {
    assertNoTransaction('storage.headObject'); validKey(key);
    try {
      const response = await this.options.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }));
      if (response.ContentLength === undefined || !response.ETag || !response.LastModified)
        throw new Error('Incomplete S3 object metadata');
      return { key, size: response.ContentLength, contentType: response.ContentType ?? 'application/octet-stream',
        etag: response.ETag, createdAt: response.LastModified };
    } catch (error) { if (notFound(error)) return null; throw error; }
  }
  async listObjects(prefix: string): Promise<readonly ObjectInfo[]> {
    assertNoTransaction('storage.listObjects');
    if (prefix) validKey(prefix);
    const objects: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const page = await this.options.client.send(new ListObjectsV2Command({
        Bucket: this.options.bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}),
      }));
      for (const object of page.Contents ?? []) {
        if (!object.Key) throw new Error('S3 list entry has no key');
        const metadata = await this.headObject(object.Key);
        if (metadata) objects.push(metadata);
      }
      if (page.IsTruncated && (!page.NextContinuationToken || page.NextContinuationToken === token))
        throw new Error('Invalid S3 pagination token');
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return objects.sort((a, b) => a.key.localeCompare(b.key));
  }
  async deleteObject(key: string): Promise<void> {
    assertNoTransaction('storage.deleteObject'); validKey(key);
    await this.options.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }
}

class S3UploadBackend implements UploadBackend {
  readonly store: S3BackupObjectStore;
  readonly prefix: string;
  constructor(readonly options: S3StoreOptions & { gymId: string }) {
    validGym(options.gymId);
    this.store = new S3BackupObjectStore(options);
    this.prefix = options.gymId + '/.storage/';
  }
  recordKey(key: string): string { return this.prefix + 'records/' + digest(key); }
  blobKey(key: string): string { return this.prefix + 'blobs/' + digest(key); }
  async reserve(key: string): Promise<void> {
    try {
      await this.options.client.send(new PutObjectCommand({
        Bucket: this.options.bucket, Key: this.recordKey(key), Body: encodeRecord({ key }),
        ContentType: 'application/json', IfNoneMatch: '*',
      }));
    } catch (error) { if (precondition(error)) throw new Error('Upload keys are immutable', { cause: error }); throw error; }
  }
  async record(key: string): Promise<UploadRecord | null> {
    const body = await this.store.getObject(this.recordKey(key));
    if (!body) return null;
    const record = decodeRecord(await new Response(body).text());
    if (record.info) {
      const deleted = await this.store.getObject(this.prefix + 'deleted/' + digest(key));
      if (deleted) record.info = { ...record.info, deletedAt: new Date(await new Response(deleted).text()) };
    }
    if (await this.store.headObject(this.prefix + 'swept/' + digest(key))) record.swept = true;
    return record;
  }
  async save(record: UploadRecord): Promise<void> {
    if (record.swept || record.info?.deletedAt) {
      try {
        await this.options.client.send(new PutObjectCommand({ Bucket: this.options.bucket,
          Key: this.prefix + (record.swept ? 'swept/' : 'deleted/') + digest(record.key),
          Body: record.swept ? '' : record.info!.deletedAt!.toISOString(), IfNoneMatch: '*', ContentType: 'text/plain' }));
      } catch (error) { if (!precondition(error)) throw error; }
      return;
    }
    await this.options.client.send(new PutObjectCommand({ Bucket: this.options.bucket,
      Key: this.recordKey(record.key), Body: encodeRecord(record), ContentType: 'application/json' }));
  }
  async records(): Promise<readonly UploadRecord[]> {
    const records: UploadRecord[] = [];
    for (const object of await this.store.listObjects(this.prefix + 'records/')) {
      const body = await this.store.getObject(object.key);
      if (body) {
        const base = decodeRecord(await new Response(body).text());
        const record = await this.record(base.key);
        if (record) records.push(record);
      }
    }
    return records;
  }
  async put(key: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<ObjectInfo> {
    return this.store.putObject(this.blobKey(key), body, { contentType });
  }
  async get(key: string): Promise<ReadableStream<Uint8Array> | null> { return this.store.getObject(this.blobKey(key)); }
  async remove(key: string): Promise<void> { await this.store.deleteObject(this.blobKey(key)); }
  async undelete(key: string): Promise<void> { await this.store.deleteObject(this.prefix + 'deleted/' + digest(key)); }
  async signedUrl(key: string, seconds: number): Promise<string> {
    return getSignedUrl(this.options.client, new GetObjectCommand({ Bucket: this.options.bucket, Key: this.blobKey(key) }),
      { expiresIn: seconds, signingDate: this.store.clock.now() });
  }
}
export class S3Uploads extends DurableUploads {
  constructor(options: S3StoreOptions & { readonly gymId: string }) {
    super(options.gymId, new S3UploadBackend(options), options.clock ?? systemClock);
  }
}

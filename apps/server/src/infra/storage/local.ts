// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { clock as systemClock } from '../../core/clock.js';
import { decodeRecord, digest, DurableUploads, encodeRecord, gymKey, validGym } from './common.js';
import type { UploadBackend, UploadRecord } from './common.js';
import type { ObjectInfo } from './index.js';

export interface LocalUploadsOptions {
  readonly root: string;
  readonly gymId: string;
  /** Absolute URL of the application download handler, without query parameters. */
  readonly downloadUrl: string;
  readonly signingKey: Uint8Array;
  readonly clock?: Clock;
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
class LocalBackend implements UploadBackend {
  readonly root: string;
  readonly signingKey: Buffer;
  readonly downloadUrl: URL;
  constructor(readonly options: LocalUploadsOptions, readonly clock: Clock) {
    validGym(options.gymId);
    this.root = join(resolve(options.root), digest(options.gymId));
    this.signingKey = Buffer.from(options.signingKey);
    if (this.signingKey.length < 32) throw new Error('Storage signing key must have at least 32 bytes');
    this.downloadUrl = new URL(options.downloadUrl);
    if (!['http:', 'https:'].includes(this.downloadUrl.protocol) || this.downloadUrl.search || this.downloadUrl.hash ||
      this.downloadUrl.username || this.downloadUrl.password)
      throw new Error('Invalid download URL');
  }
  path(key: string, file: string): string { return join(this.root, digest(key), file); }
  async reserve(key: string): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try { await mkdir(join(this.root, digest(key)), { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Upload keys are immutable', { cause: error });
      throw error;
    }
    await this.save({ key });
  }
  async record(key: string): Promise<UploadRecord | null> {
    let record: UploadRecord;
    try { record = decodeRecord(await readFile(this.path(key, 'record.json'), 'utf8')); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (record.info) {
      try { record.info = { ...record.info, deletedAt: new Date(await readFile(this.path(key, 'deleted'), 'utf8')) }; }
      catch (error) { if (!missing(error)) throw error; }
    }
    try { await readFile(this.path(key, 'swept')); record.swept = true; }
    catch (error) { if (!missing(error)) throw error; }
    return record;
  }
  async save(record: UploadRecord): Promise<void> {
    // Separate monotonic markers prevent a delayed deletion from reviving a swept object.
    if (record.swept || record.info?.deletedAt) {
      try {
        await writeFile(this.path(record.key, record.swept ? 'swept' : 'deleted'),
          record.swept ? '' : record.info!.deletedAt!.toISOString(), { flag: 'wx', mode: 0o600 });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      return;
    }
    const temporary = this.path(record.key, randomUUID() + '.tmp');
    try {
      await writeFile(temporary, encodeRecord(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path(record.key, 'record.json'));
    } finally { await rm(temporary, { force: true }); }
  }
  async records(): Promise<readonly UploadRecord[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch (error) { if (missing(error)) return []; throw error; }
    const records: UploadRecord[] = [];
    for (const entry of entries) {
      if (!/^[a-f0-9]{64}$/.test(entry)) continue;
      try {
        const base = decodeRecord(await readFile(join(this.root, entry, 'record.json'), 'utf8'));
        const record = await this.record(base.key);
        if (record) records.push(record);
      }
      catch (error) { if (!missing(error)) throw error; }
    }
    return records;
  }
  async put(key: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<ObjectInfo> {
    const temporary = this.path(key, 'body.part');
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256'); let size = 0;
    try {
      for await (const chunk of body) {
        hash.update(chunk); size += chunk.length;
        let offset = 0;
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      await file.sync();
      await file.close();
      await rename(temporary, this.path(key, 'body'));
      return { key, size, etag: hash.digest('hex'), contentType, createdAt: this.clock.now() };
    } catch (error) {
      await file.close(); await rm(temporary, { force: true }); throw error;
    }
  }
  async get(key: string): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const file = await open(this.path(key, 'body'), 'r');
      return Readable.toWeb(file.createReadStream()) as ReadableStream<Uint8Array>;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async remove(key: string): Promise<void> { await rm(this.path(key, 'body'), { force: true }); }
  signature(key: string, expires: string): Buffer {
    return createHmac('sha256', this.signingKey).update(JSON.stringify([this.options.gymId, key, expires])).digest();
  }
  async signedUrl(key: string, seconds: number): Promise<string> {
    const url = new URL(this.downloadUrl);
    const expires = String(this.clock.now().getTime() + seconds * 1000);
    url.searchParams.set('key', key); url.searchParams.set('expires', expires);
    url.searchParams.set('signature', this.signature(key, expires).toString('base64url'));
    return url.toString();
  }
}

export class LocalUploads extends DurableUploads {
  readonly #local: LocalBackend;
  constructor(options: LocalUploadsOptions) {
    const clock = options.clock ?? systemClock;
    const backend = new LocalBackend(options, clock);
    super(options.gymId, backend, clock); this.#local = backend;
  }
  /** Called by the application's download route after gym resolution. Invalid links reveal no bytes. */
  async getSigned(url: string): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.getSigned');
    let parsed: URL;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.origin !== this.#local.downloadUrl.origin || parsed.pathname !== this.#local.downloadUrl.pathname) return null;
    if (['key', 'expires', 'signature'].some((key) => parsed.searchParams.getAll(key).length !== 1)) return null;
    const key = parsed.searchParams.get('key')!;
    const expires = parsed.searchParams.get('expires')!;
    if (!/^[0-9]+$/.test(expires) || !Number.isSafeInteger(Number(expires)) || Number(expires) <= this.clock.now().getTime()) return null;
    try { gymKey(this.gymId, key); } catch { return null; }
    const signature = Buffer.from(parsed.searchParams.get('signature')!, 'base64url');
    const expected = this.#local.signature(key, expires);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    return this.get(key);
  }
}

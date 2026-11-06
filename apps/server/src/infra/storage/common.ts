// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { ObjectInfo, ReadOptions, UploadBody, UploadInfo, Uploads } from './index.js';

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
export const recordId = /^[a-f0-9]{64}$/;
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

/**
 * Runs `work` over `items` with at most `limit` calls in flight, keeping the results in order. After a failure no
 * new call starts, and it rejects with the first failure once every started call has settled, so no storage write
 * outlives the caller's lock.
 */
export async function pool<T, R>(items: readonly T[], work: (item: T) => Promise<R>, limit = 16): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0, failed = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await work(items[index]!); } catch (error) { failed = true; throw error; }
    }
  }));
  const failure = workers.find((worker) => worker.status === 'rejected');
  if (failure) throw failure.reason;
  return results;
}

/*
 * The key index: one empty entry per reserved key that is not swept, named so that names sort and filter by key
 * prefix. A name is the hex of the key's UTF-8 bytes after the gym prefix; hex keeps names to [0-9a-f], so
 * case-insensitive file systems and S3-compatible stores treat them alike. A key whose bytes don't fit, or that
 * isn't well-formed UTF-16, gets the hex of its first bytes and `-` with the key's digest, and its record names it.
 */
const indexBytes = 80;
const entryName = /^((?:[a-f0-9]{2})+)(?:-([a-f0-9]{64}))?$/;
function hex(text: string): string { return Buffer.from(text, 'utf8').toString('hex'); }
export function indexName(gymId: string, key: string): string {
  const bytes = Buffer.from(key.slice(gymId.length + 1), 'utf8');
  return key.isWellFormed() && bytes.length <= indexBytes ? bytes.toString('hex')
    : bytes.subarray(0, indexBytes).toString('hex') + '-' + digest(key);
}
/** The index entry a name refers to: its key when the name holds all of it, otherwise the record's digest. */
interface IndexEntry { readonly key?: string; readonly id: string; readonly hex: string; readonly truncated: boolean }
function indexEntry(gymId: string, name: string): IndexEntry | null {
  const parts = entryName.exec(name);
  if (!parts) return null;
  if (parts[2]) return { id: parts[2], hex: parts[1]!, truncated: true };
  const key = gymId + '/' + Buffer.from(parts[1]!, 'hex').toString('utf8');
  try { gymKey(gymId, key); } catch { return null; }
  return indexName(gymId, key) === name ? { key, id: digest(key), hex: parts[1]!, truncated: false } : null;
}
/** The name prefix that finds every entry under a key prefix; an ill-formed prefix searches the whole index. */
function indexSearch(gymId: string, prefix: string): string {
  return prefix.isWellFormed() ? hex(prefix.slice(gymId.length + 1)) : '';
}

export interface UploadBackend {
  /** Identifies the store across adapter instances, so the index is reconciled once per store and process. */
  readonly identity: readonly [object, string];
  reserve(key: string): Promise<void>;
  record(key: string, options?: ReadOptions): Promise<UploadRecord | null>;
  /** Reads a record by its digest. */
  recordAt(id: string, options?: ReadOptions): Promise<UploadRecord | null>;
  save(record: UploadRecord): Promise<void>;
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string): Promise<ObjectInfo>;
  get(key: string, options?: ReadOptions): Promise<ReadableStream<Uint8Array> | null>;
  remove(key: string): Promise<void>;
  /** Removes a deletion marker. Only restore calls it, while every other writer is stopped. */
  undelete(key: string): Promise<void>;
  signedUrl(key: string, seconds: number): Promise<string>;
  /** Writes an index entry. Idempotent. */
  index(name: string): Promise<void>;
  unindex(name: string): Promise<void>;
  /** Index entry names starting with `prefix`. */
  entries(prefix: string): Promise<readonly string[]>;
  /** Digests of every record, swept ones included. */
  recordIds(): Promise<readonly string[]>;
  /** Digests of swept records, as far as the store can list them without reading each record. */
  sweptIds(): Promise<ReadonlySet<string>>;
  /** Digests of records with a deletion marker, or undefined when only reading each record tells. */
  deletedIds(): Promise<ReadonlySet<string> | undefined>;
  /** Digests of stored blobs, or undefined when only reading each record tells. */
  blobIds(): Promise<ReadonlySet<string> | undefined>;
}

/** Stores reconciled by this process, keyed by backend identity: the 10,000 used most recently. */
const reconciled = new WeakMap<object, Map<string, Promise<void>>>();

/** Durable reservations outlive blobs, so deleting a blob never releases its key. */
export class DurableUploads implements Uploads {
  constructor(readonly gymId: string, protected readonly backend: UploadBackend, readonly clock: Clock) { validGym(gymId); }
  async put(key: string, body: UploadBody, contentType: string): Promise<UploadInfo> {
    assertNoTransaction('storage.put'); gymKey(this.gymId, key);
    // Index before reserving, so every reserved key is in the index whatever happens after.
    const name = indexName(this.gymId, key);
    await this.backend.index(name);
    try { await this.backend.reserve(key); }
    catch (error) {
      // A key another write holds keeps its entry, even while that write's reservation is still being published;
      // a swept key, or a reservation that failed with nothing reserved, needs none.
      const taken = error instanceof Error && error.message === 'Upload keys are immutable';
      const record = await this.backend.record(key).catch(() => undefined);
      if (taken ? record?.swept : record === null) await this.backend.unindex(name).catch(() => undefined);
      throw error;
    }
    const info = { ...await this.backend.put(key, bodyStream(body), contentType), key };
    await this.backend.save({ key, info });
    return info;
  }
  async get(key: string, options: ReadOptions = {}): Promise<ReadableStream<Uint8Array> | null> {
    assertNoTransaction('storage.get'); gymKey(this.gymId, key);
    options.signal?.throwIfAborted();
    const record = await this.backend.record(key, options);
    options.signal?.throwIfAborted();
    return record?.info && !record.swept ? this.backend.get(key, options) : null;
  }
  async head(key: string, options: ReadOptions = {}): Promise<UploadInfo | null> {
    assertNoTransaction('storage.head'); gymKey(this.gymId, key);
    options.signal?.throwIfAborted();
    const record = await this.backend.record(key, options);
    options.signal?.throwIfAborted();
    return record?.info && !record.swept ? record.info : null;
  }
  /** Reads only the records of keys under the prefix; swept keys have no index entry and cost nothing. */
  async list(prefix = this.gymId + '/'): Promise<readonly UploadInfo[]> {
    assertNoTransaction('storage.list');
    validKey(prefix);
    if (!prefix.startsWith(this.gymId + '/')) throw new Error('Prefix belongs to another gym');
    await this.#reconciled();
    const search = indexSearch(this.gymId, prefix);
    const candidates = (await this.#entries(search.slice(0, indexBytes * 2)))
      .filter((entry) => entry.hex.startsWith(search) || (entry.truncated && search.startsWith(entry.hex)));
    return (await pool(candidates, (entry) => this.#read(entry))).flatMap((record) =>
      record?.info && !record.swept && record.key.startsWith(prefix) ? [record.info] : [],
    ).sort((a, b) => a.key.localeCompare(b.key));
  }
  async signedUrl(key: string, seconds: number): Promise<string | null> {
    assertNoTransaction('storage.signedUrl'); gymKey(this.gymId, key); lifetime(seconds);
    return await this.head(key) ? this.backend.signedUrl(key, seconds) : null;
  }
  async markDeleted(key: string, options: ReadOptions = {}): Promise<void> {
    assertNoTransaction('storage.markDeleted'); gymKey(this.gymId, key);
    options.signal?.throwIfAborted();
    const record = await this.backend.record(key, options);
    options.signal?.throwIfAborted();
    if (record?.info && !record.swept && !record.info.deletedAt)
      await this.backend.save({ ...record, info: { ...record.info, deletedAt: this.clock.now() } });
  }
  /**
   * Restore only, under the backup lock with request and job admission closed: publishes a snapshot's file
   * under its original key, keeping the identical file when it is still stored, and clears a deletion marked
   * after the snapshot so a later sweep cannot remove a file the restored database references.
   */
  async restore(key: string, body: UploadBody, contentType: string, createdAt: Date): Promise<void> {
    assertNoTransaction('storage.restore'); gymKey(this.gymId, key);
    const record = await this.backend.record(key);
    if (record?.swept) throw new Error('Upload was swept after this snapshot');
    // Also repairs an entry missing from the index, as a restored file must list.
    await this.backend.index(indexName(this.gymId, key));
    if (record?.info) {
      if (record.info.deletedAt) await this.backend.undelete(key);
      return;
    }
    // A reservation without a published record never held readable bytes, so restore may fill it.
    if (!record) await this.backend.reserve(key);
    const info = { ...await this.backend.put(key, bodyStream(body), contentType), key, createdAt };
    await this.backend.save({ key, info });
  }
  async sweep(options: { before: Date; protectedKeys?: ReadonlySet<string> }): Promise<readonly string[]> {
    assertNoTransaction('storage.sweep'); cutoff(options.before);
    // Sweeps always reconcile first, so they also catch keys an older release wrote without an index entry.
    const reconciliation = this.#reconcile();
    this.#remember(reconciliation.then(() => undefined));
    const [{ entries, added }, deleted] = await Promise.all([reconciliation, this.backend.deletedIds()]);
    const removed: string[] = [];
    await pool(entries.filter((entry) => !deleted || deleted.has(entry.id)), async (entry) => {
      const record = await this.#read(entry);
      if (!record) return;
      // A key this pass just indexed was missing from the caller's listing, so its protection is unknown: it waits
      // for the next sweep.
      const due = !!record.info?.deletedAt && record.info.deletedAt <= options.before &&
        !options.protectedKeys?.has(record.key) && !added.has(entry.id);
      if (!record.swept && !due) return;
      // Save the tombstone first, then remove the blob and the entry; a later sweep finishes an interrupted one.
      await this.backend.save({ ...record, swept: true });
      await this.backend.remove(record.key);
      await this.backend.unindex(indexName(this.gymId, record.key));
      if (!record.swept) removed.push(record.key);
    });
    return removed.sort();
  }
  async #entries(prefix: string): Promise<IndexEntry[]> {
    return (await this.backend.entries(prefix)).flatMap((name) => indexEntry(this.gymId, name) ?? []);
  }
  /** The entry's record, or null when the entry names no record of this gym (a reservation that never happened). */
  async #read(entry: IndexEntry): Promise<UploadRecord | null> {
    const record = await this.backend.recordAt(entry.id);
    if (!record) return null;
    gymKey(this.gymId, record.key);
    return digest(record.key) === entry.id && (entry.key === undefined || record.key === entry.key) ? record : null;
  }
  /**
   * Indexes every record that has no entry and isn't swept: records written before the index existed, or by an
   * older release. It lists the index, records and swept markers, and reads only the records missing an entry.
   * It also removes the blob of a swept record without an entry, which a sweep an older release interrupted
   * leaves: the record is tombstoned, so those bytes are already unreadable. Returns the whole index and the
   * digests this pass added to it.
   */
  async #reconcile(): Promise<{ entries: IndexEntry[]; added: ReadonlySet<string> }> {
    const [entries, records, swept, blobs] = await Promise.all([this.#entries(''), this.backend.recordIds(),
      this.backend.sweptIds(), this.backend.blobIds()]);
    const indexed = new Set(entries.map((entry) => entry.id));
    const unlisted = records.filter((id) => !indexed.has(id) && !swept.has(id));
    // A store that lists blobs shows the leftovers of swept records; the other finds them among the unlisted.
    const leftovers = blobs ? [...swept].filter((id) => blobs.has(id) && !indexed.has(id)) : [];
    const found = await pool([...unlisted, ...leftovers], async (id) => {
      const record = await this.backend.recordAt(id);
      if (!record) return [];
      gymKey(this.gymId, record.key);
      if (record.swept) {
        // Remove the bytes before writing the listable swept marker, after which passes skip the record.
        await this.backend.remove(record.key);
        await this.backend.save(record);
        return [];
      }
      const name = indexName(this.gymId, record.key);
      await this.backend.index(name);
      return [indexEntry(this.gymId, name)!];
    });
    const added = found.flat();
    return { entries: entries.concat(added), added: new Set(added.map((entry) => entry.id)) };
  }
  #reconciled(): Promise<void> {
    const [owner, id] = this.backend.identity;
    const known = reconciled.get(owner)?.get(id);
    return this.#remember(known ?? this.#reconcile().then(() => undefined));
  }
  #remember(reconciliation: Promise<void>): Promise<void> {
    const [owner, id] = this.backend.identity;
    let stores = reconciled.get(owner);
    if (!stores) reconciled.set(owner, stores = new Map());
    stores.delete(id); stores.set(id, reconciliation);
    if (stores.size > 10_000) stores.delete(stores.keys().next().value!);
    // A failed pass is forgotten, so the next call retries it.
    reconciliation.catch(() => { if (stores.get(id) === reconciliation) stores.delete(id); });
    return reconciliation;
  }
}

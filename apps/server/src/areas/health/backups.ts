// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { backupRuns, forSystem } from '@plaingym/db';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { encrypt, validateRecipient } from '../../infra/age/index.js';
import type { BackupObjectStore, ObjectInfo, Uploads } from '../../infra/storage/index.js';
import { bytesStream, fileDigest, fileStream, privateDirectory, saveStream } from './backups.files.js';
import { backupKindSchema, blobName, manifestSchema, publicReferences, referenceStream, snapshotPrefix } from './backups.format.js';
import type { BackupKind, Manifest, Snapshot, UploadReference } from './backups.format.js';
import { inventory, pruneUnlocked, UnverifiedInventory, type RunStatuses } from './backups.retention.js';
import { PostgresMaintenance } from './backups.database.js';

export interface BackupOptions {
  readonly database: PostgresMaintenance;
  readonly store: BackupObjectStore;
  readonly uploads: () => Promise<ReadonlyMap<string, Uploads>>;
  readonly clock: Clock;
  readonly recipient: string;
  readonly appEncryptionKey: Buffer;
  readonly blobKey: Buffer;
  readonly stagingDirectory: string;
  readonly budgetBytes?: number;
  readonly reserveBytes?: number;
  readonly scope?: Pick<{ forSystem: typeof forSystem }, 'forSystem'>;
}
export class BackupService {
  readonly scope: { forSystem: typeof forSystem };
  constructor(readonly options: BackupOptions) {
    validateRecipient(options.recipient);
    if (options.appEncryptionKey.length !== 32 || options.blobKey.length !== 32) throw new Error('Invalid backup recovery key');
    this.scope = options.scope ?? { forSystem };
  }
  /** Each run is recorded before anything is uploaded, so an uncommitted prefix can be traced to its run. */
  readonly runs: RunStatuses = async (prefixes) => new Map((await this.scope.forSystem((tx) => tx
    .select({ prefix: backupRuns.objectPrefix, status: backupRuns.status }).from(backupRuns)
    .where(inArray(backupRuns.objectPrefix, [...prefixes])))).map((run) => [run.prefix, run.status]));
  async #upload(key: string, path: string): Promise<ObjectInfo> {
    // Every retry opens the encrypted staging file anew; the store aborts failed multipart sessions.
    for (let attempt = 1; ; attempt++) {
      try { return await this.options.store.putObject(key, fileStream(path)); }
      catch { if (attempt >= 3) throw new Error('Backup object upload failed'); }
    }
  }
  async snapshot(kind: BackupKind = 'manual'): Promise<Snapshot> {
    assertNoTransaction('backup.snapshot'); backupKindSchema.parse(kind);
    const o = this.options;
    return o.database.locked(async () => {
      const startedAt = o.clock.now(), id = o.database.newId(), prefix = snapshotPrefix(id);
      await privateDirectory(o.stagingDirectory);
      const staging = await mkdtemp(join(o.stagingDirectory, 'snapshot-'));
      const sources = await o.uploads();
      await this.scope.forSystem(async (tx) => { await tx.insert(backupRuns).values({ id, kind, startedAt, objectPrefix: prefix }); });
      let committed = false;
      try {
        // An unverifiable inventory stops pruning but never the next snapshot: one interrupted run must not end backups.
        try { await pruneUnlocked(o.store, o.blobKey, sources, startedAt, 0, o.budgetBytes, new Date(startedAt.getTime() - 1), this.runs); }
        catch (error) { if (!(error instanceof UnverifiedInventory)) throw error; }
        const previous = await inventory(o.store, o.blobKey, this.runs);
        const reusable = new Map(previous.snapshots.flatMap((s) => s.uploads.map((u) => [u.blob, u] as const)));
        const stored = new Set((await o.store.listObjects('blobs/')).map((blob) => blob.key));
        const dumpHash = createHash('sha256'); let dumpBytes = 0;
        const dump = (await o.database.dump()).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { dumpHash.update(chunk); dumpBytes += chunk.length; controller.enqueue(chunk); },
        }));
        // Encrypt pg_dump directly to local staging; no network or plaintext dump file.
        const dumpPath = join(staging, 'database.age');
        const encryptedDump = await saveStream(dumpPath, await encrypt(o.recipient, dump));
        const plainDump = { sha256: dumpHash.digest('hex'), size: dumpBytes };
        const references: UploadReference[] = [], pending: { key: string; path: string; size: number }[] = [];
        for (const [gymId, source] of sources) {
          for (const upload of await source.list()) {
            // Include deletions since the backup started, even when the tombstone appears during pg_dump.
            if (upload.deletedAt && upload.deletedAt < startedAt) continue;
            const input = await source.get(upload.key);
            if (!input) throw new Error('Upload disappeared during backup');
            const raw = join(staging, 'upload.raw');
            const plaintext = await saveStream(raw, input);
            const blob = blobName(o.blobKey, gymId, upload.key, plaintext.sha256, o.recipient);
            const known = reusable.get(blob);
            let encrypted: UploadReference['encrypted'];
            if (known) encrypted = known.encrypted;
            else if (stored.has(blob)) {
              // Never overwrite a stored blob: re-encryption would break the references of snapshots that use it.
              const body = await o.store.getObject(blob);
              if (!body) throw new Error('Upload blob disappeared during backup');
              const copy = join(staging, 'existing.age');
              encrypted = await saveStream(copy, body); await rm(copy);
            } else {
              const path = join(staging, String(references.length) + '.age');
              encrypted = await saveStream(path, await encrypt(o.recipient, fileStream(raw)));
              pending.push({ key: blob, path, size: encrypted.size });
            }
            await rm(raw);
            references.push({ gymId, key: upload.key, blob, recipient: o.recipient, contentType: upload.contentType,
              createdAt: upload.createdAt.toISOString(), plaintext, encrypted });
          }
        }
        const manifest: Manifest = manifestSchema.parse({
          version: 1, id, kind, startedAt: startedAt.toISOString(),
          database: { plaintext: plainDump, encrypted: encryptedDump },
          recovery: { appEncryptionKey: o.appEncryptionKey.toString('hex'), blobKey: o.blobKey.toString('hex') },
          uploads: references,
        });
        const manifestPath = join(staging, 'manifest.age');
        const manifestInfo = await saveStream(manifestPath, await encrypt(o.recipient, bytesStream(JSON.stringify(manifest))));
        const snapshot: Snapshot = { version: 1, id, kind, startedAt: startedAt.toISOString(),
          database: encryptedDump, manifest: manifestInfo, uploads: publicReferences(references, o.blobKey) };
        const referencePath = join(staging, 'references.json');
        const referenceInfo = await saveStream(referencePath, referenceStream(snapshot, o.blobKey));
        const existing = [...await o.store.listObjects('snapshots/'), ...await o.store.listObjects('blobs/')];
        const required = existing.reduce((n, item) => n + item.size, 0) +
          pending.reduce((n, item) => n + item.size, 0) + encryptedDump.size + manifestInfo.size + referenceInfo.size;
        if (required + (o.reserveBytes ?? 128 * 1024 * 1024) > (o.budgetBytes ?? 8_000_000_000))
          throw new Error('Backup retention budget cannot meet recovery objectives and in-flight reserve');
        for (const blob of pending) await this.#upload(blob.key, blob.path);
        await this.#upload(prefix + 'database.age', dumpPath);
        await this.#upload(prefix + 'manifest.age', manifestPath);
        // Publishing authenticated references is the final commit, after all objects have completed multipart upload.
        await this.#upload(prefix + 'references.json', referencePath);
        committed = true;
        await this.scope.forSystem(async (tx) => {
          await tx.update(backupRuns).set({ status: 'succeeded', completedAt: o.clock.now(),
            snapshotBytes: BigInt(encryptedDump.size + manifestInfo.size + referenceInfo.size),
            uploadBytes: BigInt(pending.reduce((n, p) => n + p.size, 0)) }).where(eq(backupRuns.id, id));
        });
        return snapshot;
      } catch {
        // A failed prefix is removed under the same lock. Orphan blobs can be collected by the next safe prune.
        if (!committed) for (const name of ['references.json', 'manifest.age', 'database.age']) await o.store.deleteObject(prefix + name);
        await this.scope.forSystem(async (tx) => {
          await tx.update(backupRuns).set({ status: 'failed', completedAt: o.clock.now(),
            error: 'Snapshot failed; inspect backup configuration, staging space, and destination' }).where(eq(backupRuns.id, id));
        });
        throw new Error('Snapshot failed');
      } finally { await rm(staging, { recursive: true, force: true }); }
    });
  }
  async prune(): Promise<{ retainedBytes: number; protectedKeys: ReadonlySet<string> }> {
    const o = this.options;
    return o.database.locked(async () => pruneUnlocked(o.store, o.blobKey, await o.uploads(), o.clock.now(),
      o.reserveBytes, o.budgetBytes, o.clock.now(), this.runs));
  }
}
/** Useful for restore verification and operator diagnostics without exposing recovery plaintext. */
export async function verifyFile(path: string, expected: { sha256: string; size: number }): Promise<void> {
  const actual = await fileDigest(path);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw new Error('Snapshot object checksum mismatch');
}
export async function readIdentityFile(path: string): Promise<string> {
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter((s) => s && !s.startsWith('#'));
  if (lines.length !== 1) throw new Error('Expected one age identity');
  return lines[0]!;
}

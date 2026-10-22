// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { Clock } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import { decrypt } from '../../infra/age/index.js';
import { LocalUploads } from '../../infra/storage/index.js';
import type { BackupObjectStore } from '../../infra/storage/index.js';
import { parseEncryptionKey } from '../../core/secrets.js';
import { PostgresMaintenance } from './backups.database.js';
import { atomicJson, childPath, exists, fileStream, privateDirectory, readJson, saveStream } from './backups.files.js';
import { manifestSchema, publicReferences, readReferences, snapshotPrefix, validateReferences, verifyReferences } from './backups.format.js';
import type { Manifest } from './backups.format.js';
import { verifyFile } from './backups.js';
import { RestoreGate } from './restore.gate.js';

const phaseSchema = z.enum(['verified', 'database_restored', 'migrated', 'rekeyed', 'moving_old', 'moving_new', 'uploads_switched', 'complete']);
const stateSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), phase: phaseSchema, staging: z.string().regex(/^restore-[A-Za-z0-9]+$/),
  currentKey: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RestorePhase = z.infer<typeof phaseSchema>;
export interface RestoreOptions {
  readonly database: PostgresMaintenance;
  readonly store: BackupObjectStore;
  readonly clock: Clock;
  readonly appEncryptionKey: Buffer;
  readonly stagingDirectory: string;
  readonly uploadsDirectory: string;
  readonly gate: RestoreGate;
  /** Tests can simulate power loss at each durable transition. */
  readonly checkpoint?: (phase: RestorePhase | 'old_uploads_renamed' | 'new_uploads_renamed' | 'secret_field') => void;
}
export class RestoreService {
  constructor(readonly options: RestoreOptions) {
    if (options.appEncryptionKey.length !== 32) throw new Error('Invalid current app key');
    if (resolve(options.uploadsDirectory) === resolve(options.stagingDirectory) ||
        resolve(options.stagingDirectory).startsWith(resolve(options.uploadsDirectory) + sep))
      throw new Error('Restore staging must be outside uploads');
  }
  async #download(key: string, path: string): Promise<void> {
    const body = await this.options.store.getObject(key);
    if (!body) throw new Error('Missing snapshot object');
    await saveStream(path, body);
  }
  async restore(id: string, identity: string): Promise<void> {
    assertNoTransaction('restore.begin'); z.uuid().parse(id);
    const o = this.options;
    const verified = await o.database.locked(async () => {
      if (await o.gate.isClosed()) throw new Error('Resume the existing restore first');
      await privateDirectory(o.stagingDirectory);
      const staging = await mkdtemp(join(o.stagingDirectory, 'restore-'));
      await privateDirectory(dirname(resolve(o.uploadsDirectory)));
      if ((await stat(staging)).dev !== (await stat(dirname(resolve(o.uploadsDirectory)))).dev) {
        await rm(staging, { recursive: true, force: true });
        throw new Error('Restore staging and uploads must share a filesystem');
      }
      const prefix = snapshotPrefix(id);
      let activated = false;
      try {
        const manifestCipher = join(staging, 'manifest.age');
        await this.#download(prefix + 'manifest.age', manifestCipher);
        await saveStream(join(staging, 'manifest.json'), await decrypt(identity, fileStream(manifestCipher)));
        const manifest = manifestSchema.parse(await readJson(join(staging, 'manifest.json')));
        if (manifest.id !== id) throw new Error('Manifest belongs to another snapshot');
        const blobKey = parseEncryptionKey(manifest.recovery.blobKey);
        validateReferences(manifest.uploads, blobKey);
        const referenceValue = await readReferences(o.store, prefix + 'references.json');
        const references = verifyReferences(referenceValue, blobKey, id);
        await atomicJson(join(staging, 'references.json'), referenceValue);
        if (JSON.stringify(references.uploads) !== JSON.stringify(publicReferences(manifest.uploads, blobKey)) ||
            JSON.stringify(references.database) !== JSON.stringify(manifest.database.encrypted) ||
            references.kind !== manifest.kind || references.startedAt !== manifest.startedAt)
          throw new Error('Manifest and authenticated references disagree');
        await verifyFile(manifestCipher, references.manifest);
        await this.#download(prefix + 'database.age', join(staging, 'database.age'));
        await verifyFile(join(staging, 'database.age'), references.database);
        await saveStream(join(staging, 'database.dump'), await decrypt(identity, fileStream(join(staging, 'database.age'))));
        await verifyFile(join(staging, 'database.dump'), manifest.database.plaintext);
        // Prepare a complete new LocalUploads tree without opening or modifying the current uploads tree.
        const uploadTree = join(staging, 'uploads');
        await privateDirectory(uploadTree);
        for (const [index, upload] of manifest.uploads.entries()) {
          const cipher = join(staging, 'blob-' + index + '.age'), plain = join(staging, 'blob-' + index);
          await this.#download(upload.blob, cipher);
          await verifyFile(cipher, upload.encrypted);
          await saveStream(plain, await decrypt(identity, fileStream(cipher)));
          await verifyFile(plain, upload.plaintext);
          const local = new LocalUploads({ gymId: upload.gymId, root: uploadTree,
            signingKey: o.appEncryptionKey, downloadUrl: 'https://restore.invalid/uploads',
            clock: { now: () => new Date(upload.createdAt) } });
          await local.put(upload.key, fileStream(plain), upload.contentType);
          await rm(cipher); await rm(plain);
        }
        const state = { version: 1 as const, id, phase: 'verified' as RestorePhase, staging: basename(staging),
          currentKey: createHash('sha256').update(o.appEncryptionKey).digest('hex') };
        // Durable activation closes admission on every process sharing this data volume.
        await atomicJson(o.gate.statePath, state);
        activated = true;
        return { state, manifest };
      } finally {
        if (!activated) await rm(staging, { recursive: true, force: true });
      }
    });
    // Release the backup lock before draining: an admitted worker may already be
    // waiting for that lock. Admission is closed durably by the verified journal.
    await o.gate.close();
    o.checkpoint?.('verified');
    await o.database.locked(() => this.#resume(verified.state, verified.manifest));
  }
  async resume(): Promise<void> {
    const o = this.options;
    if (!await exists(o.gate.statePath)) return;
    await o.gate.close();
    await o.database.locked(async () => {
      const state = stateSchema.parse(await readJson(o.gate.statePath));
      if (state.phase === 'complete') {
        await rm(resolve(o.uploadsDirectory) + '.previous-' + state.id, { recursive: true, force: true });
        await rm(childPath(o.stagingDirectory, state.staging), { recursive: true, force: true });
        o.gate.reopen(); return;
      }
      const staging = childPath(o.stagingDirectory, state.staging);
      const manifest = manifestSchema.parse(await readJson(join(staging, 'manifest.json')));
      if (manifest.id !== state.id) throw new Error('Restore journal does not match staged snapshot');
      verifyReferences(await readJson(join(staging, 'references.json')), parseEncryptionKey(manifest.recovery.blobKey), state.id);
      await verifyFile(join(staging, 'database.dump'), manifest.database.plaintext);
      await this.#resume(state, manifest);
    });
  }
  async #resume(state: z.infer<typeof stateSchema>, manifest: Manifest): Promise<void> {
    const o = this.options, staging = childPath(o.stagingDirectory, state.staging);
    if (state.currentKey !== createHash('sha256').update(o.appEncryptionKey).digest('hex'))
      throw new Error('Current install key changed during restore');
    const save = async (phase: RestorePhase) => {
      state.phase = phase; await atomicJson(o.gate.statePath, state); o.checkpoint?.(phase);
    };
    if (['verified', 'database_restored', 'migrated'].includes(state.phase)) {
      // Restart from the verified dump unless the rekey receipt was durably published.
      // Resetting makes both a committed pg_restore and an interrupted rekey repeatable.
      await o.database.restore(join(staging, 'database.dump'));
      await save('database_restored');
      await o.database.migrate(); // Includes applySecurity and the catalog assertion.
      await save('migrated');
      await o.database.rekey(parseEncryptionKey(manifest.recovery.appEncryptionKey), o.appEncryptionKey, o.clock,
        () => o.checkpoint?.('secret_field'));
      await save('rekeyed');
    }
    const current = resolve(o.uploadsDirectory), previous = current + '.previous-' + state.id;
    // Staging and uploads must be on the same data volume so both renames are atomic.
    await privateDirectory(dirname(current));
    if (state.phase === 'rekeyed') await save('moving_old');
    if (state.phase === 'moving_old') {
      if (!await exists(previous) && await exists(current)) {
        await rename(current, previous); o.checkpoint?.('old_uploads_renamed');
      }
      await save('moving_new');
    }
    if (state.phase === 'moving_new') {
      if (await exists(join(staging, 'uploads'))) {
        if (await exists(current)) throw new Error('Unexpected uploads directory during restore');
        await rename(join(staging, 'uploads'), current); o.checkpoint?.('new_uploads_renamed');
      } else if (!await exists(current)) throw new Error('Restored uploads tree missing');
      await save('uploads_switched');
    }
    if (state.phase === 'uploads_switched') await save('complete');
    if (state.phase === 'complete') {
      await rm(previous, { recursive: true, force: true });
      await rm(staging, { recursive: true, force: true });
      o.gate.reopen();
    }
  }
}

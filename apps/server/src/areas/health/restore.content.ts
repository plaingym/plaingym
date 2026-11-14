// SPDX-License-Identifier: AGPL-3.0-only
import { decrypt } from '../../infra/age/index.js';
import { SnapshotContentError } from './backups.content.js';
import { MetadataSizeLimitError, readJson } from './backups.files.js';
import { ageKeyReason } from './restore.failure.js';

export async function readSnapshotJson(path: string): Promise<unknown> {
  try { return await readJson(path); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof MetadataSizeLimitError)
      throw new SnapshotContentError('Invalid snapshot metadata', { cause: error });
    throw error;
  }
}

/** Scope the untyped age errors to decryption, never to the storage writing its output. */
function decryptionFailure(error: unknown): unknown {
  if (error instanceof Error && error.constructor === Error && !('code' in error) && !ageKeyReason(error))
    return new SnapshotContentError('Snapshot decryption failed', { cause: error });
  return error;
}
export async function decryptSnapshot(identity: string, input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  let plaintext: ReadableStream<Uint8Array>;
  try { plaintext = await decrypt(identity, input); }
  catch (error) { throw decryptionFailure(error); }
  const reader = plaintext.getReader();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(result.value);
      } catch (error) { reader.releaseLock(); controller.error(decryptionFailure(error)); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
}

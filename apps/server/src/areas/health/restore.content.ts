// SPDX-License-Identifier: AGPL-3.0-only
import { AgeDecryptionError, decrypt } from '../../infra/age/index.js';
import { SnapshotContentError } from './backups.content.js';
import { malformedJson, readJson } from './backups.files.js';

export async function readSnapshotJson(path: string): Promise<unknown> {
  try { return await readJson(path); }
  catch (error) {
    if (malformedJson(error))
      throw new SnapshotContentError('Invalid snapshot metadata', { cause: error });
    throw error;
  }
}

/** Only the age wrapper's header/payload failures are damaged snapshot content. */
function decryptionFailure(error: unknown): unknown {
  if (error instanceof AgeDecryptionError)
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

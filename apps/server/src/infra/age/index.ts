// SPDX-License-Identifier: AGPL-3.0-only
import { Encrypter, Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { assertNoTransaction } from '@plaingym/shared/transaction';

export { generateIdentity, identityToRecipient };
export class InvalidAgeIdentityError extends Error {
  constructor(options?: ErrorOptions) { super('Invalid age private key', options); this.name = 'InvalidAgeIdentityError'; }
}
/** Header or authenticated payload failure, after identity and transaction checks. */
export class AgeDecryptionError extends Error {
  constructor(cause: unknown) { super('Age decryption failed', { cause }); this.name = 'AgeDecryptionError'; }
}
function decryptionFailure(error: unknown): unknown {
  if (error instanceof Error && error.constructor === Error && !('code' in error) &&
      error.message !== "no identity matched any of the file's recipients") return new AgeDecryptionError(error);
  return error;
}
/** Only native public recipients; passwords and plugins are never accepted. */
export function validateRecipient(recipient: string): void {
  if (!/^age1[0-9a-z]+$/.test(recipient)) throw new Error('Invalid age public key');
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
}
export async function encrypt(recipient: string, input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  assertNoTransaction('age.encrypt');
  validateRecipient(recipient);
  const encrypter = new Encrypter();
  encrypter.addRecipient(recipient);
  return encrypter.encrypt(input);
}
export async function decrypt(identity: string, input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  assertNoTransaction('age.decrypt');
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(identity)) throw new InvalidAgeIdentityError();
  try { await identityToRecipient(identity); }
  catch (cause) { throw new InvalidAgeIdentityError({ cause }); }
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  let plaintext: ReadableStream<Uint8Array>;
  try { plaintext = await decrypter.decrypt(input); }
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

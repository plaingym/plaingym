// SPDX-License-Identifier: AGPL-3.0-only
import { Encrypter, Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { assertNoTransaction } from '@plaingym/shared/transaction';

export { generateIdentity, identityToRecipient };
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
  if (!/^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(identity)) throw new Error('Invalid age private key');
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  return decrypter.decrypt(input);
}

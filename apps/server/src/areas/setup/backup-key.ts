// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { AppError } from '@plaingym/shared';
import { encryptSecret } from '../../core/secrets.js';
import { generateIdentity, identityToRecipient } from '../../infra/age/index.js';

/**
 * The backup key parts shared by setup step 7 and Settings → Backups: a new key pair whose private key the caller shows
 * once, the check that a pasted private key matches a pending public key, and the stored form of a destination.
 */
export async function backupKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const privateKey = await generateIdentity();
  return { privateKey, publicKey: await identityToRecipient(privateKey) };
}
/** The public key of a pasted private key; an unreadable key is a 400. */
export async function recipientOf(privateKey: string): Promise<string> {
  try { return await identityToRecipient(privateKey); } catch { throw new AppError('invalid_request', 'Invalid backup key'); }
}
/** The gym's destination columns: the bucket in the clear, its credentials encrypted with `APP_ENCRYPTION_KEY`. */
export function backupColumns(key: Buffer, gymId: string, input: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string }) {
  const { accessKeyId, secretAccessKey, ...destination } = input;
  return { destination, s3Config: encryptSecret(key, { secretClass: 's3_config', owner: gymId }, JSON.stringify({ accessKeyId, secretAccessKey })) };
}
/**
 * A new random key for upload blob names and snapshot reference lists. Each reference list is authenticated with it, so
 * a destination that already holds snapshots must keep the key it has: with another key, the existing reference lists
 * fail to verify and pruning stops.
 */
export function newBlobKey(key: Buffer, gymId: string): string {
  return encryptSecret(key, { secretClass: 'backup_blob_key', owner: gymId }, randomBytes(32).toString('hex'));
}

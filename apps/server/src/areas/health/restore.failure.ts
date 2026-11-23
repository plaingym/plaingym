// SPDX-License-Identifier: AGPL-3.0-only
import { ZodError } from 'zod';
import { AgeKeyMismatchError } from '../../infra/age/index.js';
import { backupFailureCause } from './backups.failure.js';
/**
 * A fixed, public diagnostic; never pass file contents, paths, keys or upstream error text as the message.
 * The optional cause is for the structured log, which keeps its name, code and frames and drops its message.
 */
export class RestoreFailure extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RestoreFailure'; }
}

/** Library text is classified once in infra/age; restore consumes the typed mismatch. */
export function ageKeyReason(error: unknown): string | null {
  if (error instanceof AgeKeyMismatchError) return "The key doesn't open this snapshot";
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case 'Invalid age private key': return "The key file doesn't hold an age private key";
    case 'Expected one age identity': return 'The key file must hold exactly one age private key';
    default: return null;
  }
}

const identifier = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/** A value that looks like an error code or name, or null: anything else could quote a path or a secret. */
export const safeName = (value: unknown): string | null => typeof value === 'string' && identifier.test(value) ? value : null;

/**
 * What an S3 client error says about `bucket`: the backup bucket a snapshot is read from, or the uploads bucket a
 * staged restore publishes files to. One with an HTTP status or a server-supplied code is the bucket's answer
 * (`AccessDenied`, or `HTTP 403`); one with neither never got an answer (connection refused, name not found, timeout).
 * The SDK puts `$metadata` on both, so the status decides. Null for an error that isn't an S3 client's.
 */
export function s3Reason(error: unknown, bucket: 'backup' | 'uploads'): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { Code?: unknown; name?: unknown; code?: unknown; $metadata?: unknown };
  if (typeof value.$metadata !== 'object' || value.$metadata === null) return null;
  const status = (value.$metadata as { httpStatusCode?: unknown }).httpStatusCode;
  const served = safeName(value.Code);
  if (typeof status !== 'number' && !served) {
    const cause = safeName(value.code) ?? safeName(value.name);
    return 'Cannot reach the ' + bucket + ' bucket' + (cause && cause !== 'Error' ? ' (' + cause + ')' : '');
  }
  const code = served ?? safeName(value.name);
  const cause = backupFailureCause(error);
  if (cause === 'bucket_missing') return 'The ' + bucket + " bucket doesn't exist (NoSuchBucket)";
  if (bucket === 'backup' && (code === 'NoSuchKey' || code === 'NotFound')) return "The snapshot isn't in the backup bucket (" + code + '); check the snapshot ID';
  const named = code && code !== 'Error' ? code : 'HTTP ' + status;
  if (cause === 'credentials_rejected') return 'The ' + bucket + ' bucket rejected the access key or secret (' + named + ')';
  return 'The ' + bucket + ' bucket answered with error ' + named;
}

/** Why a wizard restore failed, as a class the page words in a fixed line. Only a `RestoreFailure`'s own fixed text is read. */
export type RestoreFailureClass = 'credentials_rejected' | 'bucket_missing' | 'snapshot_missing' | 'endpoint_unreachable'
  | 'wrong_key' | 'invalid_key' | 'damaged' | 'unsupported' | 'other';

export function restoreFailureClass(error: unknown): RestoreFailureClass {
  // Its cause isn't read: a staged restore's uploads-bucket failure is no problem with the backup source.
  if (error instanceof RestoreFailure) {
    if (error.message === 'A snapshot object is missing from the bucket') return 'snapshot_missing';
    if (error.message === 'The snapshot is damaged; try an earlier one') return 'damaged';
    return 'other';
  }
  if (error instanceof ZodError) return 'unsupported';
  if (error instanceof AgeKeyMismatchError) return 'wrong_key';
  if (ageKeyReason(error) !== null) return 'invalid_key';
  if (typeof error === 'object' && error !== null) {
    const value = error as { Code?: unknown; name?: unknown; $metadata?: unknown };
    if (typeof value.$metadata === 'object' && value.$metadata !== null) {
      const code = safeName(value.Code) ?? safeName(value.name);
      if (code === 'NoSuchKey' || code === 'NotFound') return 'snapshot_missing';
    }
  }
  return backupFailureCause(error);
}

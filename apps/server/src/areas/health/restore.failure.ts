// SPDX-License-Identifier: AGPL-3.0-only
import { ZodError } from 'zod';
import { AgeKeyMismatchError } from '../../infra/age/index.js';
import { backupFailureCause, fromStorage, markStorageFailure } from './backups.failure.js';
/**
 * A fixed, public diagnostic; never pass file contents, paths, keys or upstream error text as the message.
 * The optional cause is for the structured log, which keeps its name, code and frames and drops its message.
 */
export class RestoreFailure extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RestoreFailure'; }
}

/** Fixed `RestoreFailure` texts that `restoreFailureClass` recognizes; shared so thrown text and class cannot drift. */
export const restoreTexts = {
  snapshotMissing: 'The snapshot was not found in the bucket',
  objectMissing: 'A snapshot object is missing from the bucket',
  damaged: 'The snapshot is damaged; try an earlier one',
} as const;

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

/** Parenthesized safe error code or name (omitting plain `'Error'`), or empty when neither is safe. */
export function causeSuffix(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const value = error as { code?: unknown; name?: unknown };
  const name = safeName(value.code) ?? safeName(value.name);
  return name && name !== 'Error' ? ' (' + name + ')' : '';
}

/** Shared wording for an unreachable backup or uploads bucket, with `causeSuffix` when available. */
export function unreachableReason(error: unknown, bucket: 'backup' | 'uploads'): string {
  return 'Cannot reach the ' + bucket + ' bucket' + causeSuffix(error);
}

/**
 * What an S3 client error says about `bucket`: the backup bucket a snapshot is read from, or the uploads bucket a
 * staged restore publishes files to. One with an HTTP status or a server-supplied code is the bucket's answer
 * (`AccessDenied`, or `HTTP 403`); one with neither never got an answer, and only a network code or a timeout is
 * named as unreachable. The SDK puts `$metadata` on both, so the status decides. Null for an error that isn't an S3 client's.
 */
export function s3Reason(error: unknown, bucket: 'backup' | 'uploads'): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = error as { Code?: unknown; name?: unknown; code?: unknown; $metadata?: unknown };
  if (typeof value.$metadata !== 'object' || value.$metadata === null) return null;
  const status = (value.$metadata as { httpStatusCode?: unknown }).httpStatusCode;
  const served = safeName(value.Code);
  if (typeof status !== 'number' && !served) {
    return backupFailureCause(error) === 'endpoint_unreachable'
      ? unreachableReason(error, bucket)
      : 'The connection to the ' + bucket + ' bucket failed' + causeSuffix(error);
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

/** Errors thrown while a snapshot object was read from the backup bucket, including its body stream. */
const downloads = new WeakSet<object>();
/** Marks an error as raised by a snapshot download, so a bare network code in it names the storage endpoint. */
export function markDownload(error: unknown): void {
  markStorageFailure(error);
  if (typeof error === 'object' && error !== null) downloads.add(error);
}

export function restoreFailureClass(error: unknown): RestoreFailureClass {
  // Its cause isn't read: a staged restore's uploads-bucket failure is no problem with the backup source.
  if (error instanceof RestoreFailure) {
    if (error.message === restoreTexts.snapshotMissing) return 'snapshot_missing';
    if (error.message === restoreTexts.objectMissing) return 'damaged';
    if (error.message === restoreTexts.damaged) return 'damaged';
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
  const cause = backupFailureCause(error);
  // A bare network code can come from the maintenance database too, which the restore reaches before any storage call.
  if (cause === 'endpoint_unreachable' && !(typeof error === 'object' && error !== null && downloads.has(error)) && !fromStorage(error)) return 'other';
  return cause;
}

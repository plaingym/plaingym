// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupFailureCause } from '@plaingym/shared/contracts';

export type { BackupFailureCause };

const rejected = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized', 'InvalidToken', 'ExpiredToken']);
const unreachable = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Names why a backup destination call failed, from the error's HTTP status and code only. The upstream message is
 * never read: it can quote a bucket, a key ID, or other configuration, and the class is all the owner needs.
 */
export function backupFailureCause(error: unknown): BackupFailureCause {
  let current = error;
  // A failed upload whose abort failed too is an AggregateError of both: its first error is the upload's own failure.
  for (let depth = 0; depth < 5 && record(current); depth++, current = current instanceof AggregateError ? current.errors[0] : current.cause) {
    const metadata = current.$metadata;
    if (record(metadata)) {
      const status = metadata.httpStatusCode;
      const code = typeof current.Code === 'string' ? current.Code : current.name;
      if (code === 'NoSuchBucket') return 'bucket_missing';
      if (status === 401 || status === 403 || (typeof code === 'string' && rejected.has(code))) return 'credentials_rejected';
      if (typeof status !== 'number' && typeof current.Code !== 'string') return 'endpoint_unreachable';
      return 'other';
    }
    if (typeof current.code === 'string' && unreachable.has(current.code)) return 'endpoint_unreachable';
  }
  return 'other';
}

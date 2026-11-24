// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupFailureCause } from '@plaingym/shared/contracts';

export type { BackupFailureCause };

const rejected = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized', 'InvalidToken', 'ExpiredToken']);
const unreachable = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH',
  'ENETDOWN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
/** Refusals for a reason other than the key: the server clock, the account, or the object's storage class. */
const refusedOtherwise = new Set(['RequestTimeTooSkewed', 'AccountProblem', 'AllAccessDisabled', 'InvalidObjectState']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** The next error down: a failed upload whose abort failed too is an AggregateError of both, led by the upload's own failure. */
const inner = (value: Record<string, unknown>): unknown => value instanceof AggregateError ? value.errors[0] : value.cause;

/** Whether this error or one of its causes is a network failure: a connection, lookup or timeout error. */
function networkFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && record(current); depth++, current = inner(current)) {
    if ((typeof current.code === 'string' && unreachable.has(current.code)) || current.name === 'TimeoutError') return true;
  }
  return false;
}

/**
 * Names why a backup destination call failed, from the error's HTTP status and code only. The upstream message is
 * never read: it can quote a bucket, a key ID, or other configuration, and the class is all the owner needs.
 */
export function backupFailureCause(error: unknown): BackupFailureCause {
  let current = error;
  for (let depth = 0; depth < 5 && record(current); depth++, current = inner(current)) {
    const metadata = current.$metadata;
    if (record(metadata)) {
      const status = metadata.httpStatusCode;
      const code = typeof current.Code === 'string' ? current.Code : current.name;
      if (code === 'NoSuchBucket') return 'bucket_missing';
      const refused = status === 401 || status === 403;
      if (refused && typeof code === 'string' && refusedOtherwise.has(code)) return 'other';
      if (refused || (typeof code === 'string' && rejected.has(code))) return 'credentials_rejected';
      // The SDK's retry step adds `$metadata` to any failed call, so only a network error means nothing answered.
      if (typeof status !== 'number' && typeof current.Code !== 'string') return networkFailure(current) ? 'endpoint_unreachable' : 'other';
      return 'other';
    }
    if (typeof current.code === 'string' && unreachable.has(current.code)) return 'endpoint_unreachable';
  }
  return 'other';
}

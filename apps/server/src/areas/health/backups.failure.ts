// SPDX-License-Identifier: AGPL-3.0-only
import type { BackupFailureCause } from '@plaingym/shared/contracts';
import type { BackupObjectStore } from '../../infra/storage/index.js';

export type { BackupFailureCause };

const rejected = new Set(['AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized', 'InvalidToken', 'ExpiredToken']);
const unreachable = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH',
  'ENETDOWN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);
/** Refusals for a reason other than the key: the server clock, the account, or the object's storage class. */
const refusedOtherwise = new Set(['RequestTimeTooSkewed', 'AccountProblem', 'AllAccessDisabled', 'InvalidObjectState']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** The next error down: a failed upload whose abort failed too is an AggregateError of both, led by the upload's own failure. */
const inner = (value: Record<string, unknown>): unknown => value instanceof AggregateError ? value.errors[0] : value.cause;

/** Errors raised by a backup destination call (including its response body stream). */
const storageFailures = new WeakSet<object>();
/** Marks an error as raised by a backup destination call, so a bare network code in it names the storage endpoint. */
export function markStorageFailure(error: unknown): void {
  if (record(error)) storageFailures.add(error);
}

/** Errors raised while reading or sweeping the uploads source during a backup run or prune. */
const uploadsFailures = new WeakSet<object>();
/** Marks an error as raised by the uploads source, so S3 metadata on it never blames the backup destination. */
export function markUploadsFailure(error: unknown): void {
  if (record(error)) uploadsFailures.add(error);
}
/** Runs an uploads source call during a backup or prune, marking any failure as an uploads error before rethrowing. */
export async function fromUploads<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { markUploadsFailure(error); throw error; }
}

/** Whether this error or one of its causes is an S3 client's: the SDK puts `$metadata` on every error it raises. */
export function fromStorage(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && record(current); depth++, current = inner(current)) {
    if (record(current.$metadata)) return true;
  }
  return false;
}

const wrappedStores = new WeakSet<BackupObjectStore>();
async function mark<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { markStorageFailure(error); throw error; }
}
function markedStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        markStorageFailure(error);
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}
/** Wraps a backup store so rejections and body-stream read failures are marked as coming from the backup destination. */
export function markedStore(store: BackupObjectStore): BackupObjectStore {
  if (wrappedStores.has(store)) return store;
  const wrapped: BackupObjectStore = {
    putObject: (key, body, options) => mark(() => store.putObject(key, body, options)),
    getObject: async (key, options) => {
      const body = await mark(() => store.getObject(key, options));
      return body ? markedStream(body) : null;
    },
    headObject: (key, options) => mark(() => store.headObject(key, options)),
    listObjects: (prefix) => mark(() => store.listObjects(prefix)),
    deleteObject: (key) => mark(() => store.deleteObject(key)),
  };
  wrappedStores.add(wrapped);
  return wrapped;
}

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
  let current = error, storage = fromStorage(error);
  for (let depth = 0; depth < 5 && record(current); depth++, current = inner(current)) {
    if (uploadsFailures.has(current)) return 'other';
    if (storageFailures.has(current)) storage = true;
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
    if (storage && typeof current.code === 'string' && unreachable.has(current.code)) return 'endpoint_unreachable';
  }
  return 'other';
}

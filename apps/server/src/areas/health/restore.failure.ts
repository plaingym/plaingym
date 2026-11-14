// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A fixed, public diagnostic; never pass file contents, paths, keys or upstream error text as the message.
 * The optional cause is for the structured log, which keeps its name, code and frames and drops its message.
 */
export class RestoreFailure extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'RestoreFailure'; }
}

/** The age library has no typed identity errors. Keep its public key diagnostics in one place. */
export function ageKeyReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  switch (error.message) {
    case "no identity matched any of the file's recipients": return "The key doesn't open this snapshot";
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
  return 'The ' + bucket + ' bucket answered with error ' + (code && code !== 'Error' ? code : 'HTTP ' + status);
}

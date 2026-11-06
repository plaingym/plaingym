// SPDX-License-Identifier: AGPL-3.0-only
import { ZodError } from 'zod';

/**
 * A restore failure whose message the person at the terminal may read: fixed text that names a
 * field, a code or an environment variable, never a value taken from a file or an error.
 */
export class RestoreFailure extends Error {
  constructor(message: string) { super(message); this.name = 'RestoreFailure'; }
}

/** Fixed texts the restore code throws, with what each means to the owner. */
const knownMessages: readonly (readonly [RegExp, string])[] = [
  [/^no identity matched any of the file's recipients$/, "The key doesn't open this snapshot"],
  [/^Invalid age private key$/, "The key file doesn't hold an age private key"],
  [/^Expected one age identity$/, 'The key file must hold exactly one age private key'],
];
const identifier = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const safeName = (value: unknown): string | null => typeof value === 'string' && identifier.test(value) ? value : null;

/**
 * The fields a Zod error names. Only the paths of the fields the schema defines, never the values that failed.
 * A key the schema doesn't define is counted, not named: its name comes from the file and could be a pasted secret.
 */
export function issuePaths(error: ZodError): string {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    const unknown = issue.code === 'unrecognized_keys' ? issue.keys.length : 0;
    const path = unknown ? [...issue.path, '(' + unknown + ' unrecognized field' + (unknown === 1 ? '' : 's') + ')'] : issue.path;
    paths.add(path.length ? path.map(String).join('.') : '(the whole file)');
  }
  return [...paths].join(', ');
}
/**
 * What an S3 client error says. One with an HTTP status or a server-supplied code is the bucket's answer
 * (`AccessDenied`, or `HTTP 403`); one with neither never got an answer (connection refused, name not found, timeout).
 * The SDK puts `$metadata` on both, so the status decides.
 */
function s3Reason(error: object): string | null {
  const value = error as { Code?: unknown; name?: unknown; code?: unknown; $metadata?: unknown };
  if (typeof value.$metadata !== 'object' || value.$metadata === null) return null;
  const status = (value.$metadata as { httpStatusCode?: unknown }).httpStatusCode;
  const served = safeName(value.Code);
  if (typeof status !== 'number' && !served) {
    const cause = safeName(value.code) ?? safeName(value.name);
    return 'Cannot reach the backup bucket' + (cause && cause !== 'Error' ? ' (' + cause + ')' : '');
  }
  const code = served ?? safeName(value.name);
  return 'The backup bucket answered with error ' + (code && code !== 'Error' ? code : 'HTTP ' + status);
}

/** What to tell the owner about a failed restore, without a secret, a key or a field value. */
export function restoreFailureReason(error: unknown): string {
  if (error instanceof RestoreFailure) return error.message;
  if (error instanceof ZodError) return "The snapshot's contents are not in a format this version reads";
  if (typeof error === 'object' && error !== null) {
    const s3 = s3Reason(error);
    if (s3) return s3;
  }
  if (error instanceof Error) {
    const known = knownMessages.find(([pattern]) => pattern.test(error.message));
    if (known) return known[1];
  }
  return 'Unexpected error (' + (error instanceof Error ? safeName(error.name) ?? 'Error' : 'unknown') + ')';
}

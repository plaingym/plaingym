// SPDX-License-Identifier: AGPL-3.0-only
import { ZodError } from 'zod';
import { ageKeyReason, RestoreFailure, s3Reason, safeName } from '../areas/health/restore.failure.js';

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
 * What to tell the owner about a failed restore, without a secret, a key or a field value. An S3 error that reaches
 * here came from the backup bucket: after activation, the restore names the uploads bucket itself.
 */
export function restoreFailureReason(error: unknown): string {
  if (error instanceof RestoreFailure) return error.message;
  if (error instanceof ZodError) return "The snapshot's contents are not in a format this version reads";
  const s3 = s3Reason(error, 'backup');
  if (s3) return s3;
  const key = ageKeyReason(error);
  if (key) return key;
  return 'Unexpected error (' + (error instanceof Error ? safeName(error.name) ?? 'Error' : 'unknown') + ')';
}

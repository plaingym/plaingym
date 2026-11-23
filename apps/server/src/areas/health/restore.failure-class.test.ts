// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgeKeyMismatchError } from '../../infra/age/index.js';
import { RestoreFailure, restoreFailureClass } from './restore.failure.js';

const s3Error = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);

describe('restoreFailureClass', () => {
  it('names rejected credentials', () => {
    for (const code of ['SignatureDoesNotMatch', 'InvalidAccessKeyId']) {
      expect(restoreFailureClass(s3Error({ name: code, Code: code, $metadata: { httpStatusCode: 403 } }))).toBe('credentials_rejected');
    }
  });
  it('names a missing bucket', () => {
    expect(restoreFailureClass({ name: 'NoSuchBucket', Code: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } })).toBe('bucket_missing');
  });
  it('names a missing snapshot', () => {
    expect(restoreFailureClass({ name: 'NoSuchKey', Code: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })).toBe('snapshot_missing');
    expect(restoreFailureClass(new RestoreFailure('A snapshot object is missing from the bucket'))).toBe('snapshot_missing');
  });
  it('names an endpoint that never answered', () => {
    expect(restoreFailureClass(Object.assign(new Error('connect'), { code: 'ECONNREFUSED', $metadata: { attempts: 3 } }))).toBe('endpoint_unreachable');
  });
  it('names the private key problems', () => {
    expect(restoreFailureClass(new AgeKeyMismatchError(new Error('no match')))).toBe('wrong_key');
    expect(restoreFailureClass(new Error('Invalid age private key'))).toBe('invalid_key');
  });
  it('names a damaged snapshot and contents this version cannot read', () => {
    expect(restoreFailureClass(new RestoreFailure('The snapshot is damaged; try an earlier one'))).toBe('damaged');
    expect(restoreFailureClass(z.object({ a: z.number() }).safeParse({ a: 'b' }).error)).toBe('unsupported');
  });
  it('calls anything else other', () => {
    expect(restoreFailureClass(new RestoreFailure('Restore staging and uploads must share a filesystem'))).toBe('other');
    expect(restoreFailureClass(new Error('disk full'))).toBe('other');
    expect(restoreFailureClass('text')).toBe('other');
  });
  it("doesn't read a staged failure's cause", () => {
    const cause = s3Error({ name: 'AccessDenied', Code: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    expect(restoreFailureClass(new RestoreFailure('The staged restore failed', { cause }))).toBe('other');
  });
});

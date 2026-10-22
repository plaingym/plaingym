// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Uploads } from '../infra/storage/index.js';

/** Wrap every sandbox's upload provider before handing it to any feature. */
export function demoUploads(readonlyUploads: Uploads): Uploads {
  return {
    async put() { assertNoTransaction('storage.put'); throw new AppError('forbidden', 'Uploads are disabled in the demo'); },
    get: (key) => readonlyUploads.get(key), head: (key) => readonlyUploads.head(key),
    list: (prefix) => readonlyUploads.list(prefix), signedUrl: (key, ttl) => readonlyUploads.signedUrl(key, ttl),
    markDeleted: (key) => readonlyUploads.markDeleted(key), sweep: (options) => readonlyUploads.sweep(options),
  };
}

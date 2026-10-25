// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@plaingym/shared';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { Uploads } from '../infra/storage/index.js';

/** Wrap every sandbox's upload provider before handing it to any feature. */
export function demoUploads(readonlyUploads: Uploads): Uploads {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
  const pdfKey = new RegExp(`^${uuid}/waivers/${uuid}/pdf/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.pdf$`);
  return {
    async put(key, bytes, contentType) {
      assertNoTransaction('storage.put');
      // Only the waiver renderer constructs this path. Signature upload routes
      // construct their own image keys and cannot select this exception.
      if (contentType !== 'application/pdf' || !pdfKey.test(key)) throw new AppError('forbidden', 'Uploads are disabled in the demo');
      return readonlyUploads.put(key, bytes, contentType);
    },
    get: (key) => readonlyUploads.get(key), head: (key) => readonlyUploads.head(key),
    list: (prefix) => readonlyUploads.list(prefix), signedUrl: (key, ttl) => readonlyUploads.signedUrl(key, ttl),
    markDeleted: (key) => readonlyUploads.markDeleted(key), sweep: (options) => readonlyUploads.sweep(options),
  };
}

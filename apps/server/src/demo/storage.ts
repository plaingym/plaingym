// SPDX-License-Identifier: AGPL-3.0-only
import { idSchema } from '@plaingym/shared/contracts';
import { assertNoTransaction } from '@plaingym/shared/transaction';
import type { BackupObjectStore } from '../infra/storage/index.js';

/** Supply the uploads bucket, never the backup destination. */
export function createUploadPrefixCleaner(store: Pick<BackupObjectStore, 'listObjects' | 'deleteObject'>) {
  return async (gymId: string): Promise<void> => {
    assertNoTransaction('storage.deleteGym');
    idSchema.parse(gymId);
    const prefix = gymId + '/';
    for (const object of await store.listObjects(prefix)) {
      if (!object.key.startsWith(prefix)) throw new Error('Storage returned a foreign prefix');
      await store.deleteObject(object.key);
    }
  };
}

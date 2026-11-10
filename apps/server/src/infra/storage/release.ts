// SPDX-License-Identifier: AGPL-3.0-only
import { logError } from '../../core/log.js';
import type { Uploads } from './index.js';

/** Best-effort cleanup: storage errors must not replace a failed save or invalidate a committed one. */
export async function releaseFiles(gymId: string, keys: readonly string[], uploadsFor: (gymId: string) => Promise<Uploads>, event = 'photo.release_failed') {
  if (!keys.length) return;
  let uploads: Uploads;
  try { uploads = await uploadsFor(gymId); }
  catch (error) { logError(event, { gymId, keyCount: keys.length }, error); return; }
  for (const key of keys) {
    try { await uploads.markDeleted(key); }
    catch (error) { logError(event, { gymId, key }, error); }
  }
}

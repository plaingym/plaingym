// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { AppError } from '@plaingym/shared';
import { logError } from '../../core/log.js';

/** Cache successes and failures: a missing deployment asset is logged once, never per request. The line names the file, not its path. */
export function cachedLinkAsset(path: string, read = () => readFile(path, 'utf8')) {
  let cached: Promise<string> | undefined;
  return () => cached ??= read().catch((error: unknown) => {
    logError('links.asset_unavailable', { asset: basename(path) }, error);
    throw new AppError('unavailable', 'Signed-link assets are unavailable; build the assets and restart the server');
  });
}

// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { AppError } from '@plaingym/shared';

/** Cache successes and failures: a missing deployment asset is logged once, never per request. */
export function cachedLinkAsset(path: string, read = () => readFile(path, 'utf8'), log = console.error) {
  let cached: Promise<string> | undefined;
  return () => cached ??= read().catch(() => {
    log(`Signed-link asset unavailable: ${path}. Build the assets and restart the server.`);
    throw new AppError('unavailable', 'Signed-link assets are unavailable; build the assets and restart the server');
  });
}

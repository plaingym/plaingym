// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { logError } from '../core/log.js';

export const readLandingAsset = (file: string) => readFile(new URL('./screenshots/' + file, import.meta.url));
type Asset = Awaited<ReturnType<typeof readLandingAsset>>;

/** These files are immutable for the lifetime of the server. Share even an in-flight read or a missing file. */
export function createLandingAssets(read = readLandingAsset) {
  const cache = new Map<string, Promise<Asset | undefined>>();
  function asset(file: string) {
    const cached = cache.get(file);
    if (cached) return cached;
    const pending = read(file).catch((error: unknown) => {
      logError('demo.asset_unavailable', { asset: file }, error);
      // Only a file that isn't there stays missing; any other failure may pass, so a later request reads it again.
      if ((error as { code?: string } | null)?.code !== 'ENOENT') cache.delete(file);
      return undefined;
    });
    cache.set(file, pending);
    return pending;
  }
  const hashedAsset = (name: string, extension: string) => asset(`${name}.${extension}`).then(body => body && ({
    file: `${name}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}.${extension}`, body,
  }));
  let stylesheet: ReturnType<typeof hashedAsset> | undefined;
  let menuScript: ReturnType<typeof hashedAsset> | undefined;
  return {
    asset,
    stylesheet: () => stylesheet ??= hashedAsset('landing', 'css'),
    menuScript: () => menuScript ??= hashedAsset('landing-menu', 'js'),
  };
}

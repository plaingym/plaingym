// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError, contentPackSchema, type ContentPack } from '@plaingym/shared';

/** Read all definitions before returning any, so an invalid catalog fails closed. */
export async function loadContentPacks(directory = resolve('packs')): Promise<readonly ContentPack[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const packs: ContentPack[] = [];
  const ids = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const pack = contentPackSchema.parse(JSON.parse(await readFile(resolve(directory, entry.name), 'utf8')));
    if (ids.has(pack.id)) throw new AppError('conflict', 'Duplicate content pack ID');
    ids.add(pack.id);
    packs.push(pack);
  }
  return packs;
}

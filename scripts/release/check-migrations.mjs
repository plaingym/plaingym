// SPDX-License-Identifier: AGPL-3.0-only
import { pathToFileURL } from 'node:url';
import { git } from './version.mjs';

const migrations = 'packages/db/src/migrations';
const journal = `${migrations}/meta/_journal.json`;
/** @param {string} base @param {string} head @param {string} cwd */
export function checkMigrations(base, head = 'HEAD', cwd = process.cwd()) {
  if (!base) throw new Error('Give the main merge base');
  const paths = git(['ls-tree', '-r', '--name-only', base, '--', migrations], cwd).split('\n').filter(Boolean);
  for (const path of paths) {
    const before = git(['show', `${base}:${path}`], cwd);
    let after;
    try { after = git(['show', `${head}:${path}`], cwd); }
    catch { throw new Error(`Existing migration removed: ${path}`); }
    if (path !== journal) {
      // Compare object hashes, including final whitespace: migrations are immutable bytes.
      if (git(['rev-parse', `${base}:${path}`], cwd) !== git(['rev-parse', `${head}:${path}`], cwd))
        throw new Error(`Existing migration edited: ${path}`);
      continue;
    }
    const oldValue = JSON.parse(before), newValue = JSON.parse(after);
    const { entries: oldEntries, ...oldHeader } = oldValue;
    const { entries: newEntries, ...newHeader } = newValue;
    if (!Array.isArray(oldEntries) || !Array.isArray(newEntries) || newEntries.length < oldEntries.length ||
      JSON.stringify(oldHeader) !== JSON.stringify(newHeader) ||
      oldEntries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(newEntries[index])))
      throw new Error('The migration journal may only append entries');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkMigrations(process.argv[2] ?? '', process.argv[3] ?? 'HEAD');
  console.log('Existing migrations and journal entries are unchanged.');
}

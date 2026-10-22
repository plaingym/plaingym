// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleInputs } from './bundles.mjs';
import { checkHeaders } from './headers.mjs';
import { generateNotices, inventory } from './inventory.mjs';

export async function main(args = process.argv.slice(2), root = fileURLToPath(new URL('../../', import.meta.url))) {
  if (args.some((arg) => !['--write', '--headers'].includes(arg))) throw new Error('Usage: pnpm compliance [--write | --headers]');
  checkHeaders(root);
  if (args.includes('--headers')) {
    console.log('SPDX headers passed.');
    return;
  }
  const data = inventory(root, await bundleInputs(root));
  const expected = generateNotices(data);
  const output = resolve(root, 'THIRD_PARTY_LICENSES');
  if (args.includes('--write')) writeFileSync(output, expected);
  else if (readFileSync(output, 'utf8').replace(/\r\n/g, '\n') !== expected) {
    throw new Error('THIRD_PARTY_LICENSES is stale; run pnpm compliance --write and commit the result');
  }
  console.log(`Compliance passed: ${data.packages.length} installed dependencies, SPDX headers, assets and notices.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

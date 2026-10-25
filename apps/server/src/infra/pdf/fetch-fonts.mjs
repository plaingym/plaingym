// SPDX-License-Identifier: AGPL-3.0-only
// Maintainer utility; runtime never downloads fonts. Review provenance changes.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
async function get(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const provenance = JSON.parse(await readFile(new URL('./fonts/provenance.json', import.meta.url), 'utf8'));
for (const { file, url, sha256, sourceSha256 } of provenance) {
  let bytes = await get(url);
  if (createHash('sha256').update(bytes).digest('hex') !== (sourceSha256 ?? sha256)) throw new Error('Font checksum mismatch: ' + file);
  if (sourceSha256) {
    const temporary = await mkdtemp(join(tmpdir(), 'plaingym-font-'));
    try {
      const source = join(temporary, 'source.ttf'), output = join(temporary, 'static.ttf');
      await writeFile(source, bytes);
      execFileSync('python', [fileURLToPath(new URL('./instantiate-cjk.py', import.meta.url)), source, output], { windowsHide: true, timeout: 180_000 });
      bytes = await readFile(output);
      if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Instanced font checksum mismatch');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  await writeFile(new URL('./fonts/' + file, import.meta.url), bytes);
}

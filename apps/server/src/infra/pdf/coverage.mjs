// SPDX-License-Identifier: AGPL-3.0-only
// Reproduce compact cmap ranges without changing any pinned font bytes.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { create } from 'fontkit';
const root = new URL('./fonts/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const coverage = [];
for (const entry of provenance) {
  const bytes = await readFile(new URL(entry.file, root));
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('PDF font integrity failure');
  const font = create(bytes), ranges = [];
  for (const point of [...font.characterSet].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last && point === last[1] + 1) last[1] = point;
    else ranges.push([point, point]);
  }
  coverage.push({ sha256: entry.sha256, ranges });
}
await writeFile(new URL('./coverage.json', import.meta.url), JSON.stringify(coverage) + '\n');

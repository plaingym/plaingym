// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { create } from 'fontkit';
import { expect, it } from 'vitest';
import coverage from './coverage.json' with { type: 'json' };
import provenance from './fonts/provenance.json' with { type: 'json' };
it('pins the lazy-selection coverage to the unchanged full font character maps', () => {
  for (const [i, entry] of provenance.entries()) {
    const bytes = readFileSync(new URL('./fonts/' + entry.file, import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    expect(coverage[i]!.sha256).toBe(entry.sha256);
    const font = create(bytes); if (!('characterSet' in font)) throw new Error('Single face required');
    const points = coverage[i]!.ranges.flatMap(([first, last]) => Array.from({ length: last! - first! + 1 }, (_, n) => first! + n));
    expect(points).toEqual([...font.characterSet].sort((a, b) => a - b));
    if (i === 0) expect(font.hasGlyphForCodePoint(0xFFFD)).toBe(true);
  }
});

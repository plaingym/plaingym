// SPDX-License-Identifier: AGPL-3.0-only
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const selfPath = fileURLToPath(import.meta.url);

describe('no break-words', () => {
  it('refuses break-words anywhere under apps/web/src', () => {
    const hits: string[] = [];
    for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
      const full = join(entry.parentPath, entry.name);
      if (full === selfPath) continue;
      if (/\bbreak-words\b/.test(readFileSync(full, 'utf8'))) hits.push(relative(srcDir, full));
    }
    expect(hits).toEqual([]);
  });
});

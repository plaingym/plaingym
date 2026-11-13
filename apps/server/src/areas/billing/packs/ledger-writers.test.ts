// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('append-only credit ledger writers', () => {
  it('reserves updates to the erasure module', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const writers = globSync('**/*.{ts,tsx}', { cwd: root }).filter(file => !/\.(?:test|spec)\./.test(file))
      .filter(file => /\.update\(classCreditEntries\)/.test(readFileSync(new URL(file.replaceAll('\\', '/'), new URL('../../../', import.meta.url)), 'utf8')))
      .map(file => file.replaceAll('\\', '/'));
    expect(writers).toEqual(['areas/members/erasure-redaction.ts']);
  });
});

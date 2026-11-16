// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** Local targets of Markdown links and images and of HTML `href`, `src` and `srcset` attributes. */
function localTargets(markdown: string): string[] {
  const targets = [
    ...[...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!),
    ...[...markdown.matchAll(/\b(?:href|src|srcset)="([^"]+)"/g)].flatMap((match) => match[1]!.split(',').map((entry) => entry.trim().split(/\s+/)[0]!)),
  ];
  return [...new Set(targets.filter((target) => !/^(?:[a-z]+:|#)/i.test(target)).map((target) => target.split('#')[0]!))];
}

describe('root README and development guide', () => {
  // The README shows content-hashed product screenshots; refreshing them renames the files.
  it.each(['README.md', 'docs/development.md'])('%s links only to files that exist', (page) => {
    const file = resolve(root, page);
    const missing = localTargets(readFileSync(file, 'utf8')).filter((target) => !existsSync(resolve(dirname(file), target)));
    expect(missing, `${relative(root, file)} links to missing files`).toEqual([]);
  });

  it('finds the README screenshots', () => {
    const targets = localTargets(readFileSync(resolve(root, 'README.md'), 'utf8'));
    expect(targets.filter((target) => target.endsWith('.webp')).length).toBeGreaterThanOrEqual(10);
  });
});

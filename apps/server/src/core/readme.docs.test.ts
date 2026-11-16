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

  it('links every screenshot to its full-size light image and keeps its dark source', () => {
    const markdown = readFileSync(resolve(root, 'README.md'), 'utf8');
    const pictures = [...markdown.matchAll(/<picture>[\s\S]*?<\/picture>/g)];
    expect(pictures).toHaveLength(11); // Hero and ten features.
    for (const [picture] of pictures) {
      const image = /<img\b[^>]*\bsrc="([^"]+)"/.exec(picture)?.[1];
      expect(image).toMatch(/^apps\/server\/src\/demo\/screenshots\/[a-z]+-light-2x-[a-f0-9]+\.webp$/);
      expect(markdown).toContain(`<a href="${image}">\n${picture}\n</a>`);
      const sources = [...picture.matchAll(/<source\b[^>]*>/g)].map(([source]) => source);
      expect(sources).toHaveLength(1);
      expect(sources[0]).toContain('media="(prefers-color-scheme: dark)"');
      const dark = /\bsrcset="([^"]+)"/.exec(sources[0]!)?.[1];
      const screen = image!.split('/').at(-1)!.split('-light-')[0];
      expect(dark).toMatch(new RegExp(`^apps/server/src/demo/screenshots/${screen}-dark-2x-[a-f0-9]+\\.webp$`));
      for (const target of [image!, dark!]) {
        expect(existsSync(resolve(root, target)), `${target} exists`).toBe(true);
      }
    }
  });

  it('shows each feature below its heading and text, with centred phone screenshots', () => {
    const markdown = readFileSync(resolve(root, 'README.md'), 'utf8');
    const features = markdown.split('## Features\n')[1]!.split('\n## Get started')[0]!;
    expect(features).not.toMatch(/<t(?:able|r|d)\b/);
    const sections = features.split('### ').slice(1);
    expect(sections).toHaveLength(10);
    for (const section of sections) {
      expect(section).toMatch(/^[^\n]+\n\n[^<]+\n\n<p align="center">\n<a href=/);
      const phone = section.startsWith('Member portal\n') || section.startsWith('Waivers and onboarding\n');
      expect(section).toContain(`width="${phone ? '55%' : '100%'}"`);
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import screenshots from '../demo/screenshots.json' with { type: 'json' };

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

  it('links each screenshot to its full-size light image and includes a dark source when it differs', () => {
    const markdown = readFileSync(resolve(root, 'README.md'), 'utf8');
    const pictures = [...markdown.matchAll(/<picture>[\s\S]*?<\/picture>/g)];
    const screens = ['members', 'members', 'ranks', 'schedule', 'billing', 'reports', 'join', 'portal', 'waivers', 'kiosk', 'server'] as const;
    const directory = 'apps/server/src/demo/screenshots/';
    expect(pictures).toHaveLength(screens.length);
    for (const [index, key] of screens.entries()) {
      const [picture] = pictures[index]!;
      const { light, dark } = screenshots[key];
      const image = directory + light[1];
      expect(/<img\b[^>]*\bsrc="([^"]+)"/.exec(picture)?.[1]).toBe(image);
      expect(markdown).toContain(`<a href="${image}">\n${picture}\n</a>`);
      const sources = [...picture.matchAll(/<source\b[^>]*>/g)].map(([source]) => source);
      expect(sources).toEqual(dark[1] === light[1] ? [] : [
        `<source media="(prefers-color-scheme: dark)" srcset="${directory + dark[1]}">`,
      ]);
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

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinkStyles, linkStyleSources } from './styles.build.mjs';

const publicRoot = fileURLToPath(new URL('..', import.meta.url));
const names = (files: string[], root = publicRoot) => files.map(file => relative(root, file).split(sep).join('/'));

async function stylesheet(sources?: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'plaingym-styles-'));
  try {
    await buildLinkStyles(join(dir, 'links.css'), sources);
    return await readFile(join(dir, 'links.css'), 'utf8');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('public stylesheet sources', () => {
  it('scan exactly the files that render markup: every page.ts and *.page.ts', async () => {
    const sources: string[] = await linkStyleSources();
    const pages = (await readdir(publicRoot, { recursive: true })).filter(file => /(^|[\\/])([^\\/]+\.)?page\.ts$/.test(file));
    expect(names(sources)).toEqual(names(pages.map(file => join(publicRoot, file)).sort()));
    expect(names(sources)).toEqual(['links/page.ts', 'pages/join.page.ts', 'pages/page.ts']);
  });

  it('compile a class only one page file uses, and miss it when that file drops out of the sources', async () => {
    // A test-only page tree, so no production markup has to carry a sentinel class.
    const root = await mkdtemp(join(tmpdir(), 'plaingym-public-'));
    try {
      await mkdir(join(root, 'pages'), { recursive: true }); await mkdir(join(root, 'links'), { recursive: true });
      await writeFile(join(root, 'pages/page.ts'), "export const a = 'max-w-full underline';\n");
      await writeFile(join(root, 'links/page.ts'), "export const b = 'underline';\n");
      const sources: string[] = await linkStyleSources(root), pageFile = join(root, 'pages/page.ts');
      expect(names(sources, root)).toEqual(['links/page.ts', 'pages/page.ts']);
      expect(await stylesheet(sources)).toContain('.max-w-full');
      const without = await stylesheet(sources.filter(file => file !== pageFile));
      expect(without).toContain('.underline');
      expect(without).not.toContain('.max-w-full');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('emit no CSS for a utility-named identifier that only a service, job or notice uses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'plaingym-public-'));
    try {
      const write = async (file: string, text: string) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), text); };
      await write('pages/page.ts', "export const a = 'underline';\n");
      for (const file of ['pages/service.ts', 'pages/pages.jobs.ts', 'pages/notifications.ts', 'pages/service.test.ts']) await write(file, "export const b = 'italic';\n");
      const sources: string[] = await linkStyleSources(root);
      expect(names(sources, root)).toEqual(['pages/page.ts']);
      const css = await stylesheet(sources);
      expect(css).toContain('.underline');
      expect(css).not.toContain('.italic');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLinkStyles, linkStyleSources } from './styles.build.mjs';

const publicRoot = fileURLToPath(new URL('..', import.meta.url));
const isTest = (file: string) => /\.test\.tsx?$/.test(file) || file.split(sep).includes('tests');

describe('public stylesheet sources', () => {
  it('scan every public source file except tests, so a class used in any public page compiles', async () => {
    const sources: string[] = await linkStyleSources();
    const everything = (await readdir(publicRoot, { recursive: true })).filter(file => /\.ts$/.test(file) && !/\.d\.ts$/.test(file));
    const expected = everything.filter(file => !isTest(file)).map(file => join(publicRoot, file)).sort();
    expect(sources).toEqual(expected);
    const names = sources.map(file => relative(publicRoot, file).split(sep).join('/'));
    expect(names).toEqual(expect.arrayContaining(['links/page.ts', 'pages/page.ts', 'pages/join.page.ts']));
    expect(names.filter(name => name.includes('.test.') || name.startsWith('links/tests/'))).toEqual([]);
  });

  it('compile a class that only an unlisted public file uses', async () => {
    const sources: string[] = await linkStyleSources();
    const only = await readFile(join(publicRoot, 'pages/page.ts'), 'utf8');
    expect(sources).toContain(join(publicRoot, 'pages/page.ts'));
    expect(only).toContain('inline-flex min-h-11');
    const dir = await mkdtemp(join(tmpdir(), 'plaingym-styles-'));
    try {
      await buildLinkStyles(join(dir, 'links.css'));
      expect(await readFile(join(dir, 'links.css'), 'utf8')).toContain('.min-h-11');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

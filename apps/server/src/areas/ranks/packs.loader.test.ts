// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadContentPacks } from './packs.loader.js';

const directories: string[] = [];
async function catalog(files: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-packs-'));
  directories.push(directory);
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), JSON.stringify(value));
  return directory;
}
const definition = { version: 1, id: 'example', name: 'Example', rankSystems: [], programs: [], classTags: [] };
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('content pack disk loader', () => {
  it('loads shipped packs from the pnpm dev server directory without a PACKS_DIR override', async () => {
    const env = { ...process.env };
    delete env.PACKS_DIR;
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval',
      `const { loadContentPacks } = await import(${JSON.stringify(new URL('./packs.loader.ts', import.meta.url).href)}); process.stdout.write(JSON.stringify((await loadContentPacks()).map(pack => pack.id)));`,
    ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env, windowsHide: true });
    expect(JSON.parse(stdout).sort()).toEqual(['bjj', 'functional-fitness', 'judo', 'karate', 'muay-thai']);
  });
  it('honors PACKS_DIR and lets an explicit directory take precedence', async () => {
    vi.stubEnv('PACKS_DIR', await catalog({ 'env.json': { ...definition, id: 'configured' } }));
    expect((await loadContentPacks()).map((pack) => pack.id)).toEqual(['configured']);
    expect((await loadContentPacks(await catalog({ 'explicit.json': definition }))).map((pack) => pack.id)).toEqual(['example']);
    vi.stubEnv('PACKS_DIR', join(await catalog({}), 'missing'));
    await expect(loadContentPacks()).rejects.toThrow();
  });
  it('loads JSON definitions in filename order and ignores other files and directories', async () => {
    const directory = await catalog({ 'z.json': definition, 'a.json': { ...definition, id: 'first' }, 'README.md': { ignored: true } });
    await mkdir(join(directory, 'directory.json'));
    expect((await loadContentPacks(directory)).map((pack) => pack.id)).toEqual(['first', 'example']);
  });
  it.each([
    { ...definition, version: 2 },
    { ...definition, programs: [{ id: 'a', name: 'A', rankSystemId: 'missing' }] },
    { ...definition, rankSystems: [{ id: 'a', name: 'A', ranks: [{ id: 'a', name: 'A', color: 'red' }] }] },
    { ...definition, classTags: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] },
    { ...definition, unknown: 'field' },
  ])('rejects unknown versions, references, colors, duplicate IDs and fields: %j', async (invalid) => {
    await expect(loadContentPacks(await catalog({ 'invalid.json': invalid }))).rejects.toThrow();
  });
  it('rejects malformed JSON and duplicate pack identities', async () => {
    const directory = await catalog({ 'a.json': definition });
    await writeFile(join(directory, 'bad.json'), '{');
    await expect(loadContentPacks(directory)).rejects.toThrow();
    await writeFile(join(directory, 'bad.json'), JSON.stringify(definition));
    await expect(loadContentPacks(directory)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows an empty catalog and reports an unreadable directory', async () => {
    const directory = await catalog({});
    expect(await loadContentPacks(directory)).toEqual([]);
    await expect(loadContentPacks(join(directory, 'missing'))).rejects.toThrow();
  });
});

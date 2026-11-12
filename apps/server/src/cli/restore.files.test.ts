// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withRestoreFiles } from './restore.files.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'restore-files-')); roots.push(value); return value; }
const framed = (config: unknown, key: string) => {
  const json = JSON.stringify(config);
  return [Buffer.from(Buffer.byteLength(json) + '\n' + json), Buffer.from(key)];
};
describe('command-line restore file helper', () => {
  it.each([false, true])('writes app-owned private files and removes them after restore (failure=%s)', async fail => {
    const directory = await root(), config = { bucket: 'backups', identityFile: '/host/path', accessKeyId: 'test', secretAccessKey: 'test' };
    const action = withRestoreFiles(framed(config, 'private key bytes'), directory, async path => {
      const saved = JSON.parse(await readFile(path, 'utf8')) as typeof config;
      expect(saved).toMatchObject({ bucket: config.bucket });
      expect(dirname(saved.identityFile)).toBe(dirname(path));
      expect(await readFile(saved.identityFile, 'utf8')).toBe('private key bytes');
      if (process.platform !== 'win32') {
        for (const [file, mode] of [[path, 0o600], [saved.identityFile, 0o600], [dirname(path), 0o700]] as const) {
          const info = await stat(file); expect(info.mode & 0o777).toBe(mode); expect(info.uid).toBe(process.getuid!());
        }
      }
      if (fail) throw new Error('restore failed');
      return 'done';
    });
    if (fail) await expect(action).rejects.toThrow('restore failed');
    else expect(await action).toBe('done');
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects malformed, truncated and oversized input before creating files', async () => {
    const directory = await root();
    for (const input of ['no frame', '5\n{}', '2\n[]key', '1\n{key', 'x'.repeat(65_537)])
      await expect(withRestoreFiles([Buffer.from(input)], directory, async () => 'unexpected')).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
});

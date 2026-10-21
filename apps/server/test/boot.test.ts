// SPDX-License-Identifier: AGPL-3.0-only
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { buildServer } from '../build.mjs';
import { app } from '../src/app.js';
import { regularFontUrl } from '../src/assets.js';

it('serves the explicitly public health probe', async () => {
  const response = await app.request('/healthz');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
  expect((await app.request('/unknown')).status).toBe(404);
});

it('boots a relocated bundle with its font and notice, independently of the working directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-bundle-'));
  try {
    await buildServer(pathToFileURL(directory + '/'));
    expect(await readFile(join(directory, 'assets/fonts/NotoSans-Regular.ttf')))
      .toEqual(await readFile(regularFontUrl));
    expect(await readFile(join(directory, 'assets/fonts/OFL.txt'), 'utf8'))
      .toContain('SIL OPEN FONT LICENSE');
    const child = spawn(process.execPath, [join(directory, 'server.mjs')], {
      cwd: tmpdir(),
      env: { ...process.env, PORT: '0', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    try {
      const address = await new Promise<string>((resolve, reject) => {
        let stdout = '';
        const timer = setTimeout(() => reject(new Error('Server startup timed out: ' + stderr)), 10_000);
        child.once('error', (error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Server exited ${code}: ${stderr}`));
        });
        child.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          const match = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (match?.[0]) { clearTimeout(timer); resolve(match[0]); }
        });
      });
      const response = await fetch(address + '/healthz');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


it('runs a bundled CommonJS dependency that requires a Node builtin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'plaingym-commonjs-'));
  try {
    const entry = join(directory, 'dependency.cjs');
    await writeFile(entry, '// SPDX-License-Identifier: AGPL-3.0-only\nconsole.log(require("node:net").isIP("127.0.0.1"));\n');
    await buildServer(pathToFileURL(directory + '/'), pathToFileURL(entry));
    const { stdout } = await promisify(execFile)(process.execPath, [join(directory, 'server.mjs')], {
      cwd: tmpdir(), timeout: 10_000, windowsHide: true,
    });
    expect(stdout.trim()).toBe('4');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

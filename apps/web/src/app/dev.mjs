// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, watch } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createServer, loadEnv } from 'vite';
const require = createRequire(import.meta.url);
const manifest = require.resolve('@tailwindcss/cli/package.json');
const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
const cli = resolve(dirname(manifest), pkg.bin.tailwindcss);
const args = ['-i', 'src/app/styles.css', '-o', 'node_modules/.cache/plaingym/tailwind.css'];
const initial = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', windowsHide: true });
initial.on('exit', async (code) => {
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  const env = loadEnv('development', '../..', '');
  const server = await createServer({ server: {
    host: '127.0.0.1', proxy: { '/api': `http://127.0.0.1:${process.env.PORT || env.PORT || '3000'}` },
  } });
  const watcher = spawn(process.execPath, [cli, ...args, '--watch=always'], { stdio: 'inherit', windowsHide: true });
  let reloadTimer;
  const cssWatcher = watch('node_modules/.cache/plaingym', () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { server.moduleGraph.invalidateAll(); server.ws.send({ type: 'full-reload' }); }, 75);
  });
  let stopping = false;
  const stop = async (exitCode = 0) => {
    if (stopping) return;
    stopping = true; process.exitCode = exitCode;
    clearTimeout(reloadTimer); cssWatcher.close();
    watcher.kill(); await server.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
  watcher.on('error', () => { void stop(1); });
  watcher.on('exit', (exitCode) => { void stop(exitCode ?? 1); });
  try { await server.listen(); server.printUrls(); }
  catch (error) { console.error(error); await stop(1); }
});

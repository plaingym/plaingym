// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function runVm(args) {
  const [file, ...playwrightArgs] = args;
  if (!file) throw new Error('Usage: node run.mjs --vm PRIVATE_CONFIG_JSON [Playwright options]');
  const index = playwrightArgs.indexOf('--phase');
  const phase = index < 0 ? 'all' : playwrightArgs.splice(index, 2)[1];
  if (!['all', 'source', 'restore'].includes(phase)) throw new Error('Expected --phase all|source|restore');
  const code = await new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['./node_modules/@playwright/test/cli.js', 'test', ...playwrightArgs], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, E2E_VM_CONFIG: resolve(file), E2E_VM_PHASE: phase }, stdio: 'inherit', windowsHide: true,
    });
    child.on('error', fail);
    child.on('exit', (code) => ok(code ?? 1));
  });
  process.exitCode = code;
}

// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.CI) throw new Error('Product screenshots are captured by hand, never in CI');
const child = spawn(process.execPath, ['e2e/run.mjs', '--config=ux-pass/product.config.ts'], {
  cwd: fileURLToPath(new URL('../../', import.meta.url)), env: { ...process.env, DEMO_CAPTURE: '1' }, stdio: 'inherit', windowsHide: true,
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });

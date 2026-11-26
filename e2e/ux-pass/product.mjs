// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The most recent Monday 12:00 UTC at or before `now`: the capture's frozen clock, so the sample week
 * looks the same on every refresh and is never more than a week old.
 * @param {Date} now
 * @returns {string}
 */
export function captureClockInstant(now) {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const instant = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday, 12));
  if (instant > now) instant.setUTCDate(instant.getUTCDate() - 7);
  return instant.toISOString();
}

if (import.meta.main) {
  if (process.env.CI) throw new Error('Product screenshots are captured by hand, never in CI');
  const child = spawn(process.execPath, ['e2e/run.mjs', '--config=ux-pass/product.config.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, DEMO_CAPTURE: '1', CAPTURE_CLOCK_INSTANT: captureClockInstant(new Date()) },
    stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}

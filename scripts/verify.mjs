// SPDX-License-Identifier: AGPL-3.0-only
// The local check before handing off a branch: types, lint, compliance, and the tests affected by the
// branch's changes since it left main (Vitest follows imports; `forceRerunTriggers` in vitest.config.ts
// lists the changes that run every test). CI runs the full suite on every push and gates landing;
// `pnpm verify --full` runs the full suite locally too.
import { execFileSync, spawnSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
/** Where the branch left main, or null when neither main nor origin/main exists. */
function base() {
  for (const ref of ['main', 'origin/main']) {
    try { return git('merge-base', 'HEAD', ref); } catch { /* try the next ref */ }
  }
  return null;
}

const since = process.argv.includes('--full') ? null : base();
const checks = [
  ['check-types'],
  ['lint'],
  since ? ['test', '--changed', since, '--passWithNoTests'] : ['test'],
  ['compliance'],
];
if (since) console.log(`Running the tests affected by changes since ${since.slice(0, 12)} (pass --full for every test).`);
for (const [script, ...args] of checks) {
  console.log(`\n> pnpm ${[script, ...args].join(' ')}`);
  // Through the shell, so pnpm's Windows .cmd shim resolves.
  const result = spawnSync('pnpm', [script, ...args], { stdio: 'inherit', shell: true });
  if (result.status !== 0) { console.error(`\nVerification failed at pnpm ${script}.`); process.exit(result.status ?? 1); }
}
console.log('\nVerified.');

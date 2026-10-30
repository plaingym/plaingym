// SPDX-License-Identifier: AGPL-3.0-only
// The local check before handing off a branch: types, lint, compliance, and the tests the branch's
// changes since it left main affect. Vitest follows imports to find them; `forceRerunTriggers` in
// vitest.config.ts lists the changes that run every test. Whole-app tests (those that compose every
// area) are related to almost any change, so they run here only when their own folder changed; CI runs
// the full suite on every push and gates landing. `--full` runs every test; `--list` prints the
// selected test files without running anything.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const root = git('rev-parse', '--show-toplevel');
const slash = (path) => path.split('\\').join('/');
const full = process.argv.includes('--full'), listOnly = process.argv.includes('--list');

/** Where the branch left main, or null when neither main nor origin/main exists. */
function base() {
  for (const ref of ['main', 'origin/main']) {
    try { return git('merge-base', 'HEAD', ref); } catch { /* try the next ref */ }
  }
  return null;
}
/** Files changed since `since`: committed, staged, unstaged and untracked. */
function changedFiles(since) {
  const lines = [git('diff', '--name-only', since), git('ls-files', '--others', '--exclude-standard')].join('\n');
  return [...new Set(lines.split('\n').filter(Boolean))].map((file) => resolve(root, file));
}

// Modules that compose every area (or every demo seed); a test importing one is a whole-app test.
const compositionRoots = new Set(['core/registry-areas', 'core/runtime', 'demo/runtime', 'demo/service', 'demo/seed/index', 'closed-app']
  .map((module) => resolve(root, 'apps/server/src', module)));
function isWholeApp(testFile) {
  const source = readFileSync(testFile, 'utf8');
  for (const [, specifier] of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    if (compositionRoots.has(resolve(dirname(testFile), specifier).replace(/\.(js|ts|tsx)$/, ''))) return true;
  }
  return false;
}

/** The test files to run, or null for every test. */
async function selectTests(since) {
  const changed = changedFiles(since);
  // Locale catalogs are validated by `pnpm generate`; no module imports their JSON directly.
  const related = changed.filter((file) => !/[\\/]locales[\\/].*\.json$/.test(file));
  const { createVitest } = await import('vitest/node');
  const vitest = await createVitest('test', { root, related, watch: false, run: true, reporters: [] });
  try {
    const all = new Set((await vitest.globTestSpecifications()).map((spec) => spec.moduleId));
    const selected = new Set((await vitest.getRelevantTestSpecifications()).map((spec) => spec.moduleId));
    if (selected.size === all.size) return null; // A rerun trigger changed.
    const changedDirs = new Set(changed.map((file) => dirname(file)));
    return [...selected]
      .filter((file) => changed.includes(file) || changedDirs.has(dirname(file)) || !isWholeApp(file))
      .map((file) => slash(relative(root, file)))
      .sort();
  } finally { await vitest.close(); }
}

function pnpm(script, env = process.env) {
  console.log(`\n> pnpm ${script}`);
  // Through the shell, so pnpm's Windows .cmd shim resolves.
  const result = spawnSync('pnpm', [script], { stdio: 'inherit', shell: true, env, cwd: root });
  if (result.status !== 0) { console.error(`\nVerification failed at pnpm ${script}.`); process.exit(result.status ?? 1); }
}

const since = full ? null : base();
if (!listOnly) { pnpm('check-types'); pnpm('lint'); }
let tests = null;
if (since) {
  if (!existsSync(join(root, 'packages/shared/dist/locales.gen.ts'))) pnpm('generate');
  tests = await selectTests(since);
  console.log(tests === null
    ? `\nChanges since ${since.slice(0, 12)} touch shared test inputs: running every test.`
    : `\n${tests.length} test files affected by changes since ${since.slice(0, 12)} (whole-app tests run in CI).`);
}
if (listOnly) { for (const file of tests ?? ['(every test file)']) console.log(file); process.exit(0); }
if (tests === null) pnpm('test');
else if (tests.length) {
  const directory = mkdtempSync(join(tmpdir(), 'plaingym-verify-'));
  try {
    const list = join(directory, 'tests.txt');
    writeFileSync(list, tests.join('\n') + '\n');
    pnpm('test', { ...process.env, PLAINGYM_TEST_FILES: list });
  } finally { rmSync(directory, { recursive: true, force: true }); }
} else console.log('No tests affected.');
pnpm('compliance');
console.log('\nVerified.');

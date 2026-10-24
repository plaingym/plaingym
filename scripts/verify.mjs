// SPDX-License-Identifier: AGPL-3.0-only
// Runs the full local validation once per tree. `pnpm verify` checks the clean checkout and records its
// tree; the pre-push hook (`--pre-push`) skips deletions and trees already recorded, so pushing the same
// tree again (an integration branch, then main) never repeats the suite. CI stays the authoritative check.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const checks = ['check-types', 'lint', 'test', 'compliance'];
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const stamps = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'plaingym-verified');
// A result counts only for the same tree on the same Node version and platform.
const stamp = (tree) => join(stamps, `${tree}-${process.version}-${process.platform}-${process.arch}`);
const verified = (tree) => existsSync(stamp(tree));

/** The checkout's tree, or null when tracked or untracked files differ from it (ignored files don't count). */
function cleanTree() {
  return git('status', '--porcelain', '--untracked-files=normal') === '' ? git('rev-parse', 'HEAD^{tree}') : null;
}
function run(tree) {
  for (const script of checks) {
    console.log(`\n> pnpm ${script}`);
    // Through the shell, so pnpm's Windows .cmd shim resolves.
    const result = spawnSync('pnpm', [script], { stdio: 'inherit', shell: true });
    if (result.status !== 0) { console.error(`\nVerification failed at pnpm ${script}.`); process.exit(result.status ?? 1); }
  }
  // The suite ran against the working tree, so it must still be the tree being recorded.
  if (cleanTree() !== tree) { console.error('\nThe checkout changed while verifying; nothing recorded.'); process.exit(1); }
  mkdirSync(stamps, { recursive: true });
  writeFileSync(stamp(tree), JSON.stringify({ commit: git('rev-parse', 'HEAD'), verifiedAt: new Date().toISOString() }) + '\n');
  console.log(`\nVerified tree ${tree}.`);
}

if (process.argv[2] === '--pre-push') {
  // Git passes one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
  const pushed = readFileSync(0, 'utf8').split('\n').map((line) => line.trim().split(/\s+/)).filter((fields) => fields.length === 4);
  const trees = new Set();
  for (const [, sha] of pushed) {
    if (/^0+$/.test(sha)) continue; // Deleting a remote ref pushes no code.
    trees.add(git('rev-parse', `${sha}^{tree}`));
  }
  for (const tree of trees) {
    if (verified(tree)) { console.log(`Tree ${tree} already verified; skipping the suite.`); continue; }
    if (cleanTree() !== tree) {
      console.error(`Tree ${tree} isn't verified, and this checkout isn't that clean tree.\n` +
        'Check out the commit being pushed, run `pnpm verify`, then push again.');
      process.exit(1);
    }
    run(tree);
  }
} else {
  const tree = cleanTree();
  if (!tree) { console.error('Commit or stash every change first: verification records the committed tree.'); process.exit(1); }
  if (verified(tree) && process.argv[2] !== '--force') console.log(`Tree ${tree} already verified (pass --force to run again).`);
  else run(tree);
}

// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, releasePattern, root } from './version.mjs';
import { checkCommits } from './check-commits.mjs';
import { checkMigrations } from './check-migrations.mjs';

export function compare(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number), right = b.replace(/^v/, '').split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}
export function proposal(previous, messages, migrations) {
  if (!previous) return '1.0.0';
  if (!messages.length && !migrations) return null;
  const [major, minor, patch] = previous.replace(/^v/, '').split('.').map(Number);
  if (messages.some((message) => /^[^\n:]+!:/.test(message) || /^BREAKING[ -]CHANGE: /m.test(message))) return `${major + 1}.0.0`;
  if (migrations || messages.some((message) => /^feat(?:\([^)]*\))?: /.test(message))) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function changelogSection(text, version) {
  const sections = text.split(/(?=^## \[)/m);
  const section = sections.find((part) => part.startsWith(`## [${version.replace(/^v/, '')}]`));
  if (!section) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return section.trim() + '\n';
}
export function insertSection(text, section, clearUnreleased = false) {
  const sections = text.split(/(?=^## \[)/m);
  const header = sections.shift();
  const unreleased = sections.shift();
  if (!unreleased?.startsWith('## [Unreleased]')) throw new Error('CHANGELOG.md needs ## [Unreleased] first');
  const versionOf = (value) => /^## \[([^\]]+)\]/.exec(value)?.[1] ?? '';
  const version = versionOf(section);
  if (sections.some((part) => versionOf(part) === version)) throw new Error(`Changelog already contains ${version}`);
  return [header?.trimEnd(), clearUnreleased ? '## [Unreleased]' : unreleased.trimEnd(), ...[...sections, section].sort((a, b) => compare(versionOf(b), versionOf(a))).map((part) => part.trimEnd())].join('\n\n') + '\n';
}

/** The text under `## [Unreleased]`: notes a release must carry into its own section. */
export function unreleasedNotes(text) {
  const section = text.split(/(?=^## \[)/m).find((part) => part.startsWith('## [Unreleased]'));
  return section?.replace('## [Unreleased]', '').trim() ?? '';
}
/** The path filters of a workflow's `push` trigger. */
export function pushPathFilter(workflow) {
  const list = (key) => {
    const block = /^ {2}push:\n((?: {4}.*\n)*)/m.exec(workflow)?.[1] ?? '';
    const inline = new RegExp(`^ {4}${key}: \\[(.*)\\]$`, 'm').exec(block)?.[1];
    if (inline !== undefined) return inline.split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
    const items = new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n)*)`, 'm').exec(block)?.[1] ?? '';
    return items.split('\n').filter(Boolean).map((item) => item.trim().replace(/^- /, '').replace(/^'|'$/g, ''));
  };
  return { paths: list('paths'), ignored: list('paths-ignore') };
}
const globPattern = (glob) => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?|\*/g, (stars) => stars === '*' ? '[^/]*' : '.*') + '$');
/** Whether GitHub skips a workflow for a push that changes these paths. */
export function skippedByFilter({ paths, ignored }, changed) {
  const matches = (path, globs) => globs.some((glob) => globPattern(glob).test(path));
  if (paths.length) return !changed.some((path) => matches(path, paths));
  return ignored.length > 0 && changed.every((path) => matches(path, ignored));
}

const manifests = ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/db/package.json', 'packages/shared/package.json'];
const requiredWorkflows = { CI: 'ci.yml', 'Repo compliance': 'compliance.yml', 'Image checks': 'image.yml' };
const defaultGh = (args, cwd) => execFileSync('gh', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
/**
 * Each required workflow passed on HEAD or, when its path filters skipped HEAD, on the nearest commit it ran on. Every
 * commit in between must be one those filters skip, or the workflow never saw that change.
 */
function assertWorkflowsPassed({ cwd, repo, head, gh, limit }) {
  const run = (...args) => git(args, cwd);
  const runsOf = new Map();
  const runs = (commit) => {
    if (!runsOf.has(commit)) runsOf.set(commit, JSON.parse(gh(['run', 'list', '-R', repo, '--commit', commit, '--limit', '100', '--json', 'workflowName,conclusion,status,createdAt'], cwd)));
    return runsOf.get(commit);
  };
  for (const [name, file] of Object.entries(requiredWorkflows)) {
    const filter = pushPathFilter(readFileSync(join(root, '.github/workflows', file), 'utf8'));
    for (let commit = head; ; commit = run('rev-parse', `${commit}^`)) {
      const latest = runs(commit).filter((item) => item.workflowName === name).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
      if (latest) {
        if (latest.status !== 'completed' || latest.conclusion !== 'success') throw new Error(`${name} has not passed for ${commit}`);
        break;
      }
      if (commit === limit || !skippedByFilter(filter, run('diff', '--name-only', `${commit}^`, commit).split('\n').filter(Boolean)))
        throw new Error(`${name} has not passed for ${head}`);
    }
  }
}

/** Signs the tag with the terminal attached, so ssh-keygen or gpg can ask for the key's passphrase. */
function signTag(tag, cwd) {
  const result = spawnSync('git', ['tag', '-s', tag, '-m', tag], { cwd, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`git tag -s ${tag} failed`);
}

/** Maintainer entry point. Tests supply only gh's answer; all repository operations and signatures are real. */
export function release({ cwd = process.cwd(), version: explicit, notesFile, rollbackFloor, gh = defaultGh, edit = editNotes, log = console.log, tag = signTag } = {}) {
  cwd = resolve(cwd);
  const run = (...args) => git(args, cwd);
  if (run('status', '--porcelain')) throw new Error('A release requires a clean working tree');
  const branch = run('branch', '--show-current');
  if (!branch) throw new Error('A release requires a branch, not detached HEAD');
  // Fetch only refs; no working files or tags are created by preflight.
  run('fetch', 'origin', '--prune', '--tags');
  const head = run('rev-parse', 'HEAD');
  if (head !== run('rev-parse', `refs/remotes/origin/${branch}`)) throw new Error(`The branch ${branch} is not level with origin`);
  const tags = run('tag', '--merged', 'HEAD', '--list', 'v*').split('\n').filter((tag) => releasePattern.test(tag.slice(1))).sort((a, b) => compare(b, a));
  const previous = tags[0];
  const messages = (previous ? run('log', '--format=%B%x00', `${previous}..HEAD`) : '').split('\0')
    .map((message) => message.trim()).filter((message) => message && !/^(?:docs: changelog for v|chore\(release\): v)/.test(message));
  const changed = previous ? run('diff', '--name-only', previous, 'HEAD').split('\n').filter(Boolean) : [];
  const migrations = changed.some((path) => path.startsWith('packages/db/src/migrations/'));
  const next = proposal(previous, messages, migrations);
  if (next === null) { log('Nothing to release.'); return null; }
  const version = explicit?.replace(/^v/, '') ?? next;
  if (!releasePattern.test(version) || compare(version, '1.0.0') < 0) throw new Error('Public releases start at 1.0.0; use X.Y.Z');
  if (compare(version, next) < 0) throw new Error(`The commits and migrations require at least ${next}`);
  const [major, minor, patch] = version.split('.').map(Number);
  const isPatch = patch > 0;
  if (isPatch && (!previous || previous.replace(/^v/, '').split('.').slice(0, 2).join('.') !== `${major}.${minor}` || migrations))
    throw new Error('A patch must follow its existing minor and must not contain migrations');
  const requiredBranch = isPatch ? `release/${major}.${minor}` : 'main';
  if (branch !== requiredBranch) throw new Error(`${version} must be released on ${requiredBranch}`);
  if (run('tag', '--list', `v${version}`)) throw new Error(`v${version} already exists`);
  if (previous) { checkCommits(previous, head, cwd); checkMigrations(previous, head, cwd); }
  let signingKey = '', signingFormat = '';
  try { signingKey = run('config', '--get', 'user.signingkey'); } catch { /* Config exits 1 when absent. */ }
  try { signingFormat = run('config', '--get', 'gpg.format'); } catch { /* Default is OpenPGP. */ }
  if (!signingKey && signingFormat !== 'ssh') throw new Error('Configure user.signingkey or gpg.format ssh before releasing');
  const remote = run('remote', 'get-url', 'origin');
  const repository = /(?:github\.com[/:])([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1];
  // Scratch repositories still use the same explicit repository parameter, supplied as local configuration.
  let configuredRepository = '';
  try { configuredRepository = run('config', '--get', 'plaingym.repository'); } catch { /* Use the GitHub origin. */ }
  const repo = configuredRepository || repository;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Cannot determine the GitHub repository from origin (or plaingym.repository)');
  // Never past the previous release: the first commit with no parent to compare stops the walk too.
  assertWorkflowsPassed({ cwd, repo, head, gh, limit: previous ? run('rev-parse', `${previous}^{commit}`) : run('rev-list', '--max-parents=0', 'HEAD').split('\n')[0] });
  let mainPath;
  if (isPatch) {
    if (run('rev-parse', 'main') !== run('rev-parse', 'origin/main')) throw new Error('main must be level with origin before adding the patch changelog');
    const worktree = run('worktree', 'list', '--porcelain').split('\n\n').find((entry) => entry.split('\n').includes('branch refs/heads/main'));
    mainPath = worktree?.split('\n')[0]?.replace(/^worktree /, '');
    if (mainPath && git(['status', '--porcelain'], mainPath)) throw new Error('The main worktree must be clean');
  }
  let floor = rollbackFloor;
  if (!floor && isPatch) floor = run('show', `${previous}:deploy/release/rollback-floor.txt`).trim();
  // The minor before this one is the previous release's, which versions can skip past.
  if (!floor) floor = !previous || minor === 0 ? version : `${previous.replace(/^v/, '').split('.').slice(0, 2).join('.')}.0`;
  floor = floor.replace(/^v/, '');
  if (!releasePattern.test(floor) || compare(floor, '1.0.0') < 0 || compare(floor, version) > 0) throw new Error('The rollback floor must be a release between 1.0.0 and this version');
  if (isPatch && floor !== run('show', `${previous}:deploy/release/rollback-floor.txt`).trim()) throw new Error('A patch cannot change its rollback floor');
  // The Release workflow would refuse this tag once pushed (deploy/release/previous-minor.mjs): only a major sets a boundary.
  if (!isPatch && minor > 0 && previous && compare(previous, floor) < 0) throw new Error(`The rollback floor ${floor} excludes the previous release ${previous}; use a major release for this boundary`);
  const hostFiles = changed.filter((path) => /^deploy\/(?:update\.sh|lib\.sh|rotate-key\.sh|install\.sh|compose\.yaml|Caddyfile|postgres\/|systemd\/|release-signing\.pem)/.test(path));
  const groups = { Added: [], Changed: [], Fixed: [] };
  for (const message of messages) groups[/^feat(?:\(|:|!)/.test(message) ? 'Added' : /^fix(?:\(|:|!)/.test(message) ? 'Fixed' : 'Changed']
    .push(`- ${message.split('\n')[0].replace(/^[^:]+: /, '')}`);
  const changes = previous ? Object.entries(groups).filter(([, entries]) => entries.length)
    .map(([heading, entries]) => `### ${heading}\n\n${entries.join('\n')}`).join('\n\n') : '### Added\n\n<!-- Write a short first-release summary here. -->';
  const migrationNote = !previous ? 'initial schema (fresh installation).' : migrations ? 'yes; take a pre-upgrade snapshot.' : 'none.';
  const changelogPath = join(cwd, 'CHANGELOG.md');
  // The release empties Unreleased, so what was written there goes into its notes.
  const unreleased = unreleasedNotes(readFileSync(changelogPath, 'utf8'));
  const template = `${unreleased ? unreleased + '\n\n' : ''}${changes}\n\n### Upgrade notes\n\n- Migrations: ${migrationNote}\n- Rollback floor: ${floor}.\n- Manual steps: ${hostFiles.length ? `review and copy the changed host files before updating: ${hostFiles.join(', ')}. Reload systemd if a unit changed. See deploy/README.md.` : 'none.'}\n`;
  const temporary = mkdtempSync(join(tmpdir(), 'plaingym-release-notes-'));
  let notes;
  try {
    if (notesFile) {
      notes = readFileSync(resolve(notesFile), 'utf8');
      if (!notes.includes(unreleased)) notes = `${unreleased}\n\n${notes}`;
    } else {
      const path = join(temporary, 'notes.md');
      writeFileSync(path, template); edit(path, cwd); notes = readFileSync(path, 'utf8');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  // Repeat until nothing changes, so removing one comment can't join the pieces of another.
  for (let previous; previous !== notes;) { previous = notes; notes = notes.replace(/<!--[\s\S]*?-->/g, ''); }
  notes = notes.trim();
  if (!/### (?:Added|Changed|Fixed|Removed|Deprecated|Security)\s+\S/.test(notes.split('### Upgrade notes')[0])) throw new Error('Write a nonempty release summary before releasing');
  if (!notes.includes('### Upgrade notes') || !notes.includes(`Rollback floor: ${floor}`)) throw new Error('Keep Upgrade notes and the checked rollback floor in the release notes');
  if (!notes.includes(`Migrations: ${migrationNote}`) || !notes.includes('Manual steps:') || hostFiles.some((path) => !notes.includes(path)))
    throw new Error('Keep the migration facts and changed host-file instructions in the upgrade notes');
  const section = `## [${version}] - ${new Date().toISOString().slice(0, 10)}\n\n${notes}\n`;
  const changelog = insertSection(readFileSync(changelogPath, 'utf8'), section, true);
  let mainChangelog;
  if (isPatch) mainChangelog = insertSection(run('show', 'main:CHANGELOG.md'), section);
  // Every preflight and both changelogs are checked before modifying a working file.
  for (const path of manifests) {
    const file = join(cwd, path), manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.version = version; manifest.private = true;
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
  }
  writeFileSync(changelogPath, changelog);
  mkdirSync(join(cwd, 'deploy/release'), { recursive: true });
  writeFileSync(join(cwd, 'deploy/release/rollback-floor.txt'), floor + '\n');
  run('add', '--', ...manifests, 'CHANGELOG.md', 'deploy/release/rollback-floor.txt');
  const before = run('rev-parse', 'HEAD');
  run('commit', '-m', `chore(release): v${version}`);
  // Git can exit 0 with an unsigned annotated tag when the signer couldn't run (a passphrase it couldn't ask for), so
  // read the tag back. On any failure, the tag and the release commit go: the tree was clean, so nothing else is lost.
  try {
    tag(`v${version}`, cwd);
    const signed = hasTagSignature(run('cat-file', '-p', `v${version}`));
    if (!signed) throw new Error(`v${version} came back unsigned, so it and the release commit must be removed. Check user.signingkey and that its key's passphrase can be entered, then run the release again.`);
  } catch (error) {
    const errors = [error];
    try { if (run('tag', '--list', `v${version}`)) run('tag', '-d', `v${version}`); }
    catch (cleanupError) { errors.push(cleanupError); }
    try { run('reset', '--hard', before); }
    catch (cleanupError) { errors.push(cleanupError); }
    if (errors.length > 1) throw new AggregateError(errors, `${error.message}; release cleanup also failed`, { cause: error });
    throw error;
  }
  let createdWorktree = false;
  try {
    if (isPatch) {
      if (!mainPath) {
        mainPath = join(cwd, '.worktrees', `release-notes-${version}`);
        run('worktree', 'add', mainPath, 'main'); createdWorktree = true;
      }
      writeFileSync(join(mainPath, 'CHANGELOG.md'), mainChangelog);
      git(['add', '--', 'CHANGELOG.md'], mainPath);
      git(['commit', '-m', `docs: changelog for v${version}`], mainPath);
    }
  } finally { if (createdWorktree) run('worktree', 'remove', mainPath); }
  log(`Created v${version}. Nothing was pushed. Review, then push main${isPatch ? `, ${branch}` : ''} and refs/tags/v${version}.`);
  return { version, floor, section };
}

/** Git's supported SSH, OpenPGP and X.509 tag signature envelopes. */
export function hasTagSignature(text) {
  return /^-----BEGIN (?:(?:SSH|PGP) SIGNATURE|SIGNED MESSAGE)-----$/m.test(text);
}

function editNotes(path, cwd) {
  const editor = git(['var', 'GIT_EDITOR'], cwd);
  const quoted = process.platform === 'win32' ? `"${path.replaceAll('"', '""')}"` : `'${path.replaceAll("'", "'\\''")}'`;
  const result = spawnSync(`${editor} ${quoted}`, { cwd, shell: true, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('The release notes editor failed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args[0] && !args[0].startsWith('--')) options.version = args.shift();
    while (args.length) {
      const flag = args.shift(), value = args.shift();
      if (!value || !['--notes-file', '--rollback-floor'].includes(flag)) throw new Error('Usage: pnpm release [X.Y.Z] [--notes-file FILE] [--rollback-floor X.Y.Z]');
      options[flag === '--notes-file' ? 'notesFile' : 'rollbackFloor'] = value;
    }
    release(options);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}

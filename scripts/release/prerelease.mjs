// SPDX-License-Identifier: AGPL-3.0-only
// Nightly prereleases of main (deploy/README.md, "Prereleases"). The Prerelease workflow runs `plan` to decide whether
// and as what version main's commit is published, and `notes` for the GitHub prerelease's text. Nothing here writes
// to the repository: the version comes from the existing tags and the migrations diff, never from a commit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertWorkflowsPassed, compare, defaultGh, WorkflowNotPassedError } from './release.mjs';
import { git, releasePattern } from './version.mjs';

/** A prerelease publishes only after these passed on its commit (or, where path filters skipped it, the nearest one). */
export const prereleaseWorkflows = { CI: 'ci.yml', 'Repo compliance': 'compliance.yml' };
export const publishRef = 'refs/heads/main';
const migrations = 'packages/db/src/migrations';
const maxListed = 300;

/** The next prerelease: the first follows the root package.json's minor, later ones are the next patch unless the
 * migrations changed since the previous prerelease (check-tag.sh's rule for patches), then the next minor.
 * @param {{ previous?: string, product: string, migrationsChanged: boolean }} input
 */
export function prereleaseVersion({ previous, product, migrationsChanged }) {
  const base = previous ? previous.replace(/^v/, '') : product;
  if (!releasePattern.test(base)) throw new Error(`Not a plain semantic version: ${base}`);
  const [major, minor, patch] = base.split('.').map(Number);
  if (major !== 0) throw new Error(`Prereleases are 0.x versions; ${previous ? `the previous release is ${previous}` : `package.json is ${product}`}`);
  if (!previous || migrationsChanged) return `v0.${minor + 1}.0`;
  return `v0.${minor}.${patch + 1}`;
}

/** The rollback floor: the previous prerelease when its image passed the smoke test on this release's schema, else
 * the release itself, so an install never rolls back to an image that wasn't shown to run on the new schema.
 * @param {string} version @param {string | undefined} previous @param {boolean} passed
 */
export function chooseFloor(version, previous, passed) {
  return previous && passed ? previous : version;
}

/** @param {string} cwd @param {string} head */
function tagsOf(cwd, head) {
  return git(['tag', '--merged', head, '--list', 'v*'], cwd).split('\n')
    .filter((tag) => tag.startsWith('v') && releasePattern.test(tag.slice(1))).sort((a, b) => compare(b, a));
}

/**
 * Whether and as what to publish HEAD. Only `refs/heads/main` publishes; any other ref gets a dry run of the same
 * version with build metadata. On main, nothing is built when main hasn't moved since the previous prerelease, when
 * a stable release exists, or when CI or Repo compliance hasn't passed on the commit.
 * @param {{ cwd?: string, head?: string, ref?: string, repo?: string, gh?: (args: string[], cwd: string) => string }} options
 */
export function planPrerelease({ cwd = process.cwd(), head = 'HEAD', ref = '', repo = '', gh = defaultGh } = {}) {
  const run = (...args) => git(args, cwd);
  const commit = run('rev-parse', `${head}^{commit}`);
  const previous = tagsOf(cwd, commit)[0];
  const skip = (reason) => ({ build: false, publish: false, previous, reason });
  if (previous && compare(previous, '1.0.0') >= 0) return skip(`${previous} is a stable release; prereleases are 0.x versions only.`);
  if (previous && run('rev-parse', `${previous}^{commit}`) === commit) return skip(`main has not moved since ${previous}.`);
  const migrationsChanged = previous ? run('diff', '--name-only', previous, commit, '--', migrations) !== '' : false;
  const product = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  const version = prereleaseVersion({ previous, product, migrationsChanged });
  if (run('tag', '--list', version)) throw new Error(`${version} already exists but is not on ${commit}`);
  const plan = { version, previous, migrationsChanged, commit };
  if (ref !== publishRef) {
    return { ...plan, build: true, publish: false, buildVersion: `${version.slice(1)}+0.g${commit.slice(0, 7)}`,
      reason: `Dry run of ${version}: only ${publishRef} publishes prereleases.` };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Give the GitHub repository (OWNER/REPO)');
  try {
    assertWorkflowsPassed({ cwd, repo, head: commit, gh, workflows: prereleaseWorkflows,
      limit: previous ? run('rev-parse', `${previous}^{commit}`) : run('rev-list', '--max-parents=0', commit).split('\n')[0] });
  } catch (error) {
    if (error instanceof WorkflowNotPassedError) return skip(`${error.message}; nothing is published.`);
    throw error;
  }
  return { ...plan, build: true, publish: true, buildVersion: version.slice(1), reason: `Publishing ${version}.` };
}

/** The GitHub prerelease's notes: what it is, its upgrade facts, and the commits since the previous prerelease.
 * @param {{ cwd?: string, previous?: string, commit: string, floor: string }} options
 */
export function prereleaseNotes({ cwd = process.cwd(), previous, commit, floor }) {
  const run = (...args) => git(args, cwd);
  const subjects = previous ? run('log', '--no-merges', '--format=%h %s', `${previous}..${commit}`).split('\n').filter(Boolean) : [];
  const changed = previous && run('diff', '--name-only', previous, commit, '--', migrations) !== '';
  const listed = subjects.slice(0, maxListed).map((line) => `- ${line.slice(line.indexOf(' ') + 1)} (${line.slice(0, line.indexOf(' '))})`);
  if (subjects.length > maxListed) listed.push(`- and ${subjects.length - maxListed} earlier commits`);
  return [
    `Nightly prerelease of \`main\` at ${commit}, for trying out the latest changes. It is not for a gym's live data.`,
    '',
    'Its release manifest is signed with the prerelease key (`deploy/prerelease-signing.pem`), not the release key. Installs that trust only `release-signing.pem` refuse it.',
    '',
    '### Upgrade notes',
    '',
    `- Migrations: ${!previous ? 'first prerelease.' : changed ? `yes, since ${previous}; take a pre-upgrade snapshot.` : `none since ${previous}.`}`,
    `- Rollback floor: ${floor}.`,
    '',
    previous ? `### Commits since ${previous}` : '### Commits',
    '',
    ...(previous ? listed : ['First prerelease.']),
    '',
  ].join('\n');
}

/** GitHub output lines for the workflow's prepare step. */
export function planOutputs(plan) {
  const lines = { build: String(plan.build), publish: String(plan.publish), previous: plan.previous ?? '' };
  if (plan.build) Object.assign(lines, { version: plan.version, build_version: plan.buildVersion, image_tag: plan.buildVersion.replace(/\+/g, '_') });
  return Object.entries(lines).map(([key, value]) => `${key}=${value}`).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const plan = planPrerelease({ head: process.env.GITHUB_SHA ?? 'HEAD', ref: process.env.GITHUB_REF ?? '', repo: process.env.GITHUB_REPOSITORY ?? '' });
    console.error(`::notice::${plan.reason}`);
    console.log(planOutputs(plan));
  } else if (command === 'notes') {
    const [previous = '', commit = '', floor = ''] = args;
    console.log(prereleaseNotes({ previous: previous || undefined, commit, floor }));
  } else {
    console.error('Usage: prerelease.mjs plan | notes PREVIOUS COMMIT FLOOR');
    process.exit(2);
  }
}

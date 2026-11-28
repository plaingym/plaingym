// SPDX-License-Identifier: AGPL-3.0-only
// Nightly prereleases of next (deploy/README.md, "Prereleases"). The Prerelease workflow runs `plan` on main to decide
// whether and as what version next's head is published, and `notes` for the GitHub prerelease's text. Nothing here
// writes to the repository: the version comes from the existing tags, never from a commit.
import { pathToFileURL } from 'node:url';
import { assertWorkflowsPassed, compare, defaultGh, WorkflowNotPassedError } from './release.mjs';
import { git, releasePattern } from './version.mjs';

/** A prerelease publishes only after these passed on its commit (or, where path filters skipped it, the nearest one). */
export const prereleaseWorkflows = { CI: 'ci.yml', 'Repo compliance': 'compliance.yml' };
export const publishRef = 'refs/heads/main';
/** What a run on main plans: next's head, as the workflow fetched it. */
export const nextRef = 'refs/remotes/origin/next';
/** A nightly prerelease's tag: vX.Y.0-nightly.N, a semver prerelease of the minor after the newest release. */
export const nightlyPattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.0-nightly\.([1-9][0-9]*)$/;
const migrations = 'packages/db/src/migrations';
const maxListed = 300;

const isRelease = (tag) => tag.startsWith('v') && releasePattern.test(tag.slice(1));
const newestFirst = (tags) => tags.sort((a, b) => compare(b, a));

/** The nightly after the release `base` (vX.Y.Z, at least v1.0.0): vX.(Y+1).0-nightly.N, where N is 1 above the
 * highest N of that minor among `tags`, or 1 when there is none.
 * @param {{ base: string, tags: string[] }} input
 */
export function prereleaseVersion({ base, tags }) {
  if (!isRelease(base) || compare(base, '1.0.0') < 0) throw new Error(`Not a release at or above v1.0.0: ${base}`);
  const [major, minor] = base.slice(1).split('.').map(Number);
  const prefix = `v${major}.${minor + 1}.0-nightly.`;
  const numbers = tags.filter((tag) => tag.startsWith(prefix) && nightlyPattern.test(tag)).map((tag) => Number(tag.slice(prefix.length)));
  return `${prefix}${Math.max(0, ...numbers) + 1}`;
}

/** The rollback floor: the previous prerelease when its image passed the smoke test on this release's schema, else
 * the release itself, so an install never rolls back to an image that wasn't shown to run on the new schema.
 * @param {string} version @param {string | undefined} previous @param {boolean} passed
 */
export function chooseFloor(version, previous, passed) {
  return previous && passed ? previous : version;
}

/**
 * Whether and as what to publish. Only a run on `refs/heads/main` publishes, and it plans next's head
 * (`refs/remotes/origin/next`), not main's; any other ref gets a dry run of its own commit (`head`), with build
 * metadata. Nothing is built when there is no next branch, when next hasn't moved since the newest nightly merged into
 * it, when the minor the nightly would precede is already released but not merged into next, or (on main) when CI or
 * Repo compliance hasn't passed on next's head.
 * @param {{ cwd?: string, head?: string, ref?: string, repo?: string, gh?: (args: string[], cwd: string) => string }} options
 */
export function planPrerelease({ cwd = process.cwd(), head = 'HEAD', ref = '', repo = '', gh = defaultGh } = {}) {
  const run = (...args) => git(args, cwd);
  const publishing = ref === publishRef;
  if (publishing && !run('for-each-ref', '--format=%(objectname)', nextRef)) return { build: false, publish: false, reason: 'No next branch.' };
  const commit = run('rev-parse', `${publishing ? nextRef : head}^{commit}`);
  const merged = run('tag', '--merged', commit, '--list', 'v*').split('\n');
  const base = newestFirst(merged.filter((tag) => isRelease(tag) && compare(tag, '1.0.0') >= 0))[0];
  const previous = newestFirst(merged.filter((tag) => nightlyPattern.test(tag)))[0];
  const where = publishing ? 'next' : commit;
  const skip = (reason) => ({ build: false, publish: false, previous, commit, reason });
  if (!base) return skip(`No release at or above v1.0.0 is merged into ${where}.`);
  if (previous && run('rev-parse', `${previous}^{commit}`) === commit) return skip(`${publishing ? 'next' : commit} has not moved since ${previous}.`);
  const tags = run('tag', '--list', 'v*').split('\n');
  const version = prereleaseVersion({ base, tags });
  // base is the newest release merged here, so any release above the nightly's version isn't merged.
  const unmerged = tags.filter((tag) => isRelease(tag) && compare(tag, version) > 0).sort(compare)[0];
  if (unmerged) return skip(`${unmerged} is released but not merged into ${where}; merge main into next.`);
  const plan = { version, previous, base, commit };
  if (!publishing) {
    return { ...plan, build: true, publish: false, buildVersion: `${version.slice(1)}+0.g${commit.slice(0, 7)}`,
      reason: `Dry run of ${version}: only ${publishRef} publishes prereleases, of next's head.` };
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Give the GitHub repository (OWNER/REPO)');
  try {
    assertWorkflowsPassed({ cwd, repo, head: commit, gh, workflows: prereleaseWorkflows, limit: run('rev-parse', `${previous ?? base}^{commit}`) });
  } catch (error) {
    if (error instanceof WorkflowNotPassedError) return skip(`${error.message}; nothing is published.`);
    throw error;
  }
  return { ...plan, build: true, publish: true, buildVersion: version.slice(1), reason: `Publishing ${version} from next at ${commit}.` };
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
    `Nightly prerelease of \`next\` at ${commit}, for trying out the latest changes. It is not for a gym's live data.`,
    '',
    'Its release manifest is signed with the prerelease key (`deploy/prerelease-signing.pem`), not the release key. Installs that trust only `release-signing.pem` refuse it.',
    '',
    '### Upgrade notes',
    '',
    `- Migrations: ${!previous ? 'first nightly prerelease.' : changed ? `yes, since ${previous}; take a pre-upgrade snapshot.` : `none since ${previous}.`}`,
    `- Rollback floor: ${floor}.`,
    '',
    previous ? `### Commits since ${previous}` : '### Commits',
    '',
    ...(previous ? listed : ['First nightly prerelease.']),
    '',
  ].join('\n');
}

/** GitHub output lines for the workflow's prepare step. */
export function planOutputs(plan) {
  const lines = { build: String(plan.build), publish: String(plan.publish), previous: plan.previous ?? '', commit: plan.commit ?? '' };
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

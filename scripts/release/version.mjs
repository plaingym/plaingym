// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @param {string[]} args @param {string} cwd */
export function git(args, cwd = root, { raw = false, timeout = 120_000 } = {}) {
  const output = execFileSync('git', args, { cwd, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
    env: { ...process.env, LC_ALL: 'C', GIT_CEILING_DIRECTORIES: dirname(resolve(cwd)) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  return raw ? output : output.trim();
}

/** Build identity is calculated before compilation, never from the deployed working directory.
 * @param {string} cwd
 */
export function buildInfo(cwd = root, env = process.env) {
  if (env.APP_BUILD_VERSION || env.APP_BUILD_REVISION) {
    const archive = /^\d+\.\d+\.\d+\+unknown$/.test(env.APP_BUILD_VERSION ?? '') && env.APP_BUILD_REVISION === 'unknown';
    if (!archive && (!/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(env.APP_BUILD_VERSION ?? '') || !/^[a-f0-9]{40}$/.test(env.APP_BUILD_REVISION ?? '')))
      throw new Error('Supply both APP_BUILD_VERSION and the full APP_BUILD_REVISION');
    return { version: env.APP_BUILD_VERSION ?? '', commit: env.APP_BUILD_REVISION ?? '' };
  }
  const product = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  if (!releasePattern.test(product)) throw new Error('package.json must contain a plain semantic version');
  // Archives must not inherit an enclosing repository's identity. A .git file is a linked worktree.
  if (!existsSync(join(cwd, '.git'))) return { version: `${product}+unknown`, commit: 'unknown' };
  const commit = git(['rev-parse', 'HEAD'], cwd);
  const short = commit.slice(0, 7);
  const dirty = git(['status', '--porcelain', '--untracked-files=normal'], cwd) !== '';
  const tags = git(['tag', '--merged', 'HEAD', '--list', 'v*'], cwd).split('\n')
    .filter((tag) => tag.startsWith('v') && releasePattern.test(tag.slice(1)));
  let version = `${product}+0.g${short}`;
  if (tags.length) {
    const description = git(['describe', '--tags', '--long', '--abbrev=7', ...tags.flatMap((tag) => ['--match', tag]), 'HEAD'], cwd);
    const match = /^v([\d.]+)-(\d+)-g([a-f0-9]+)$/.exec(description);
    if (!match) throw new Error(`Unexpected git describe output: ${description}`);
    version = match[2] === '0' && !dirty ? (match[1] ?? product) : `${match[1]}+${match[2]}.g${match[3]}`;
  }
  if (dirty) version += '.dirty';
  return { version, commit };
}

/** A Release dry run's version always has build metadata, also on a commit that already carries its tag, so the
 * dry run never looks like the release it rehearses.
 * @param {{ version: string, commit: string }} info
 */
export function dryRunVersion(info) {
  return info.version.includes('+') ? info.version : `${info.version}+0.g${info.commit.slice(0, 7)}`;
}

/** Archives have no commit to link to; callers can supply their exact public source URL. */
export function imageSourceUrl(info, source = process.env.SOURCE_URL) {
  return source ?? `https://github.com/plaingym/plaingym${info.commit === 'unknown' ? '' : `/tree/${info.commit}`}`;
}

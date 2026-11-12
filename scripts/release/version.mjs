// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** @param {string[]} args @param {string} cwd */
export function git(args, cwd = root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Build identity is calculated before compilation, never from the deployed working directory.
 * @param {string} cwd
 */
export function buildInfo(cwd = root, env = process.env) {
  if (env.APP_BUILD_VERSION || env.APP_BUILD_REVISION) {
    if (!/^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(env.APP_BUILD_VERSION ?? '') || !/^[a-f0-9]{40}$/.test(env.APP_BUILD_REVISION ?? ''))
      throw new Error('Supply both APP_BUILD_VERSION and the full APP_BUILD_REVISION');
    return { version: env.APP_BUILD_VERSION ?? '', commit: env.APP_BUILD_REVISION ?? '' };
  }
  const product = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version;
  if (!releasePattern.test(product)) throw new Error('package.json must contain a plain semantic version');
  let commit;
  try { commit = git(['rev-parse', 'HEAD'], cwd); }
  catch (error) {
    if (error.code === 'ENOENT' || /not a git repository/i.test(String(error.stderr)))
      return { version: `${product}+unknown`, commit: 'unknown' };
    throw error;
  }
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

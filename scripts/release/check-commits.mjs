// SPDX-License-Identifier: AGPL-3.0-only
import { pathToFileURL } from 'node:url';
import { git } from './version.mjs';

export const subjectPattern = /^(feat|fix|refactor|docs|chore|build|ci|test|perf|style|revert)(\([^()\r\n]+\))?!?: \S[^\r\n]*$/;
/** @param {string} message */
export function checkMessage(message) {
  if (message.startsWith('\uFEFF') || message.includes('\r')) throw new Error('Commit messages must use LF and UTF-8 without a byte-order mark');
  if (!subjectPattern.test(message.split('\n')[0] ?? '')) throw new Error('Use a conventional commit subject: type(scope)!: subject');
  if (/^(?:Claude|Codex|ChatGPT|AI)[ -]Session\s*:/im.test(message) || /https?:\/\/(?:www\.)?(?:claude\.ai|chatgpt\.com)\/(?:chat|share|session|code)\//i.test(message))
    throw new Error('AI session trailers and attribution links are not allowed');
}
/** @param {string} base @param {string} head @param {string} cwd */
export function checkCommits(base, head = 'HEAD', cwd = process.cwd()) {
  if (!base || /^0+$/.test(base)) throw new Error('Give the pushed range or the new branch merge base; do not audit old history');
  const commits = git(['rev-list', `${base}..${head}`], cwd).split('\n').filter(Boolean);
  for (const commit of commits) {
    try { checkMessage(git(['show', '-s', '--format=%B', commit], cwd, { raw: true })); }
    catch (error) { throw new Error(`${commit}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  }
  return commits.length;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Checked ${checkCommits(process.argv[2] ?? '', process.argv[3] ?? 'HEAD')} commits.`);
}

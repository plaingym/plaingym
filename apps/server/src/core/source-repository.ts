// SPDX-License-Identifier: AGPL-3.0-only

// The same rule as `releasePattern` in scripts/release/version.mjs (a test keeps them equal). That
// file reads its own location at import time, which fails where a page script runs under jsdom.
const releaseVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const isRelease = (version: string): boolean => releaseVersionPattern.test(version);

function sourceRepository(source: string, releaseOnly: boolean): string | undefined {
  let url: URL;
  try { url = new URL(source); }
  catch { return undefined; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;

  const segments = url.pathname.split('/').filter(Boolean);
  if (releaseOnly && segments.length !== 2 && (segments.length !== 4 || segments[2] !== 'tree')) return undefined;
  const owner = segments[0], repo = segments[1]?.replace(/\.git$/, '');
  return owner && repo ? `${url.origin}/${owner}/${repo}` : undefined;
}

export function repositoryRoot(source: string): string | undefined {
  return sourceRepository(source, false);
}

export function releaseRepository(source: string): string | undefined {
  return sourceRepository(source, true);
}

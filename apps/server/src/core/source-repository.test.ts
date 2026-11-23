// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isRelease, releaseRepository, repositoryRoot } from './source-repository.js';

describe('source repository links', () => {
  it.each([
    ['https://github.com/plaingym/plaingym', 'https://github.com/plaingym/plaingym'],
    ['https://github.com/plaingym/plaingym.git', 'https://github.com/plaingym/plaingym'],
    ['https://github.com/plaingym/plaingym/tree/0.5.0', 'https://github.com/plaingym/plaingym'],
    ['https://git.example.org/acme/gym/tree/v0.5.0?x=1#source', 'https://git.example.org/acme/gym'],
    ['http://git.example.org:8080/acme/gym/', 'http://git.example.org:8080/acme/gym'],
  ])('takes the release repository from %s', (source, root) => {
    expect(releaseRepository(source)).toBe(root);
  });

  it.each([
    'https://gitlab.com/group/sub/gym',
    'https://gitlab.com/group/gym/-/tree/main',
    'https://github.com/a/b/archive/refs/tags/v0.5.0.tar.gz',
    'https://github.com/a/b/tree',
    'https://github.com/a/.git',
    'https://example.org/',
    'https://example.org/one',
    'ftp://example.org/a/b',
    'not a url',
  ])('does not link releases for %s', source => {
    expect(releaseRepository(source)).toBeUndefined();
  });

  it('can find the repository root of a GitHub file for the product page', () => {
    expect(repositoryRoot('https://github.com/a/b/blob/main/x')).toBe('https://github.com/a/b');
  });

  it.each([['0.5.0', true], ['01.2.3', false], ['0.5.0-rc.1', false], ['0.4.0+0.g6e55ffe', false], ['dev', false]])(
    'recognizes the release status of %s', (version, release) => {
      expect(isRelease(version)).toBe(release);
    },
  );
});

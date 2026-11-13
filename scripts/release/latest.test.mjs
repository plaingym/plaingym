// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { isLatest, latestReleaseFlag } from './latest.mjs';
import { hasTagSignature } from './release.mjs';

test('latest follows stable semantic versions, including old-minor backports', () => {
  const releases = ['v1.9.12', 'v1.10.0'].map(tagName => ({ tagName }));
  assert.equal(isLatest('v1.9.13', releases), false);
  assert.equal(isLatest('v1.10.1', releases), true);
  assert.equal(isLatest('v1.11.0', [...releases, { tagName: 'v2.0.0', isDraft: true }, { tagName: 'v3.0.0', isPrerelease: true }]), true);
  assert.equal(isLatest('v1.0.0', []), true);
  assert.throws(() => isLatest('v1.0.0-rc.1', []), /stable/);
});

test('latest lookup reads every API page and refuses lookup failures', () => {
  const run = (binary, args, options) => {
    assert.equal(binary, 'gh');
    assert.deepEqual(args, ['api', '--paginate', '--slurp', 'repos/example/app/releases?per_page=100']);
    assert.equal(options.timeout, 120_000); assert.equal(options.killSignal, 'SIGKILL');
    return JSON.stringify([[{ tag_name: 'v1.0.0', draft: false, prerelease: false }],
      [{ tag_name: 'v2.0.0', draft: false, prerelease: false }]]);
  };
  assert.equal(latestReleaseFlag('v1.0.1', run, 'example/app'), false);
  assert.throws(() => latestReleaseFlag('v1.0.1', () => { throw new Error('API unavailable'); }), /API unavailable/);
});

test('tag readback accepts each Git signing format and refuses an unsigned tag', () => {
  for (const envelope of ['SSH SIGNATURE', 'PGP SIGNATURE', 'SIGNED MESSAGE'])
    assert.equal(hasTagSignature(`tag message\n-----BEGIN ${envelope}-----\n`), true);
  assert.equal(hasTagSignature('unsigned annotated tag'), false);
});

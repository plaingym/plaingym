// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPrune, pruneNightlies } from './prune-nightlies.mjs';

const nightly = (tagName) => ({ tagName, isDraft: false, isPrerelease: true });
const range = (minor, from, to) => Array.from({ length: to - from + 1 }, (_, index) => `v1.${minor}.0-nightly.${from + index}`);
/** 20 nightlies, two stable releases, a v0.Y.Z prerelease and a draft nightly, in GitHub's newest-first order. */
const releases = [
  { tagName: 'v1.2.0-nightly.9', isDraft: true, isPrerelease: true },
  ...range(2, 1, 8).reverse().map(nightly),
  { tagName: 'v1.1.0', isDraft: false, isPrerelease: false },
  ...range(1, 1, 12).reverse().map(nightly),
  { tagName: 'v1.0.0', isDraft: false, isPrerelease: false },
  { tagName: 'v0.5.0', isDraft: false, isPrerelease: true },
];
const version = (id, ...tags) => ({ id, name: `sha256:${String(id).padStart(64, '0')}`, metadata: { package_type: 'container', container: { tags } } });

test('only the nightlies beyond the 14 highest are deleted, never a release, a draft or a v0.Y.Z prerelease', () => {
  const plan = planPrune({ releases, versions: [] });
  assert.deepEqual(plan.releases, range(1, 1, 6));
  assert.deepEqual(plan.kept, [...range(1, 7, 12), ...range(2, 1, 8)].reverse());
  assert.equal(plan.kept[0], 'v1.2.0-nightly.8');
  // Fourteen or fewer nightlies: nothing to delete.
  for (const count of [14, 3, 0]) {
    const few = range(1, 1, count).map(nightly);
    assert.deepEqual(planPrune({ releases: [...few, ...releases.filter((release) => !/nightly/.test(release.tagName))], versions: [] }).releases, []);
  }
  // A nightly-shaped tag GitHub doesn't mark prerelease is neither counted nor deleted.
  const marked = releases.map((release) => release.tagName === 'v1.1.0-nightly.3' ? { ...release, isPrerelease: false } : release);
  const unmarked = planPrune({ releases: marked, versions: [] });
  assert.deepEqual(unmarked.releases, ['v1.1.0-nightly.1', 'v1.1.0-nightly.2', 'v1.1.0-nightly.4', 'v1.1.0-nightly.5', 'v1.1.0-nightly.6']);
  assert.equal(unmarked.kept.length, 14);
  assert.ok(!unmarked.kept.includes('v1.1.0-nightly.3'));
  // Malformed nightly tags are not nightlies.
  const odd = planPrune({ releases: [...releases, nightly('v1.1.0-nightly.01'), nightly('v1.1.1-nightly.1')], versions: [] });
  assert.deepEqual(odd.releases, range(1, 1, 6));
  assert.throws(() => planPrune({ releases, versions: [], keep: 0 }), /at least one/);
});

/** gh's answers: the release list, package versions in pages, and deletes that fail when `failing` names them. */
function fakeGh({ pages, failing = [] }) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'release' && args[1] === 'list') {
      assert.deepEqual([...args.slice(0, 3), args[3].toLowerCase(), ...args.slice(4)],
        ['release', 'list', '-R', 'example/app', '--limit', '1000', '--json', 'tagName,isDraft,isPrerelease']);
      return JSON.stringify(releases);
    }
    if (args[0] === 'api' && args[1] === '--paginate') {
      assert.deepEqual(args, ['api', '--paginate', '--slurp', '/orgs/example/packages/container/app/versions?per_page=100']);
      return JSON.stringify(pages);
    }
    if (failing.some((name) => args.includes(name))) throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 403: Resource not accessible by integration\n' });
    return '';
  };
  return { gh, calls };
}

test('package versions from every page are deleted only when all their tags belong to deleted nightlies', () => {
  const pages = [
    [version(1, 'v1.1.0-nightly.1'), version(2, 'v1.1.0-nightly.2-arm64'), version(3)],
    [version(4, 'v1.1.0-nightly.3', 'v1.1.0'), version(5, 'v1.0.0-amd64'), version(6, 'v1.2.0-nightly.8')],
    [version(7, 'v1.1.0-nightly.6-amd64', 'v1.1.0-nightly.6'), version(8, 'v0.5.0'), version(9, 'v1.1.0-nightly.7')],
  ];
  const lines = [];
  const { gh, calls } = fakeGh({ pages });
  const result = pruneNightlies({ repo: 'example/App', gh, log: (line) => lines.push(line) });
  assert.equal(result.failed, 0);
  assert.deepEqual(result.versions.map(({ id }) => id), [1, 2, 7]);
  const deletes = calls.filter((args) => args.includes('delete') || args.includes('DELETE'));
  assert.deepEqual(deletes, [
    ...range(1, 1, 6).map((tag) => ['release', 'delete', tag, '-R', 'example/App', '--cleanup-tag', '--yes']),
    ...[1, 2, 7].map((id) => ['api', '-X', 'DELETE', `/orgs/example/packages/container/app/versions/${id}`]),
  ]);
  assert.match(lines.at(-1), /^::notice::Kept 14 nightlies \(v1\.1\.0-nightly\.7 to v1\.2\.0-nightly\.8\); 6 older releases and 3 package versions to delete, 0 failed\.$/);
});

test('one failing delete leaves the others tried and fails the run', () => {
  const pages = [[version(1, 'v1.1.0-nightly.1')], [version(2, 'v1.1.0-nightly.2-arm64')], []];
  const lines = [];
  const { gh, calls } = fakeGh({ pages, failing: ['v1.1.0-nightly.2'] });
  const result = pruneNightlies({ repo: 'example/app', gh, log: (line) => lines.push(line) });
  assert.equal(result.failed, 1);
  assert.equal(calls.filter((args) => args[1] === 'delete' || args[1] === '-X').length, 8);
  assert.ok(lines.includes('::error::Could not delete the v1.1.0-nightly.2 release and its tag: HTTP 403: Resource not accessible by integration'));
  assert.ok(lines.includes('Deleted the v1.1.0-nightly.3 release and its tag.'));
  assert.ok(lines.includes('Deleted package version 2 (v1.1.0-nightly.2-arm64).'));
});

test('a failed list deletes nothing', () => {
  const calls = [];
  const gh = (args) => { calls.push(args); if (args[0] === 'api') throw new Error('HTTP 404'); return JSON.stringify(releases); };
  assert.throws(() => pruneNightlies({ repo: 'example/app', gh, log: () => {} }), /HTTP 404/);
  assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['release', 'list'], ['api', '--paginate']]);
  assert.throws(() => pruneNightlies({ repo: 'example', gh, log: () => {} }), /OWNER\/REPO/);
  const notPages = (args) => args[0] === 'api' ? JSON.stringify([{ id: 1 }]) : JSON.stringify(releases);
  assert.throws(() => pruneNightlies({ repo: 'example/app', gh: notPages, log: () => {} }), /not a list of pages/);
});

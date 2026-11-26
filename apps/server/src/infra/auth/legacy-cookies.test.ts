// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Single-gym installs read the old cookie names only before 1.1.0: remove the fallback, its tests and the
// sentences describing it, and their entries in scripts/release/removal-deadlines.json, then delete this test.
type Sources = Record<'service.ts' | 'cookies.ts', string>;

const root = '../../../../../';
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(read(`${root}package.json`)) as { version: string };

// The release command reads the same list, and refuses these versions before it bumps the version.
const { removals } = JSON.parse(read(`${root}scripts/release/removal-deadlines.json`)) as
  { removals: { from: string; file: string; identifier: string }[] };
const removalOf = (name: keyof Sources) => {
  const found = removals.find(({ file }) => file.endsWith(`/${name}`));
  if (!found) throw new Error(`removal-deadlines.json lists no ${name}`);
  return found;
};
// Read from the paths the release command checks, so a moved file fails here instead of passing that check unseen.
const sources: Sources = { 'service.ts': read(root + removalOf('service.ts').file), 'cookies.ts': read(root + removalOf('cookies.ts').file) };

/** Compares X.Y.Z versions the way the release command does. */
function compare(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  return left[0]! - right[0]! || left[1]! - right[1]! || left[2]! - right[2]!;
}

/** From a source's listed version on, the names of those that still hold their fallback identifier; none before it. */
function overdue(version: string, sources: Sources): string[] {
  return (Object.keys(sources) as (keyof Sources)[]).filter((name) => {
    const { from, identifier } = removalOf(name);
    return compare(version, from) >= 0 && sources[name].includes(identifier);
  });
}

describe('the fallback to the old cookie names', () => {
  it('is gone from version 1.1.0', () => {
    expect(overdue(version, sources),
      `Version ${version} must not read the old cookie names: remove legacySessionCookies (infra/auth/service.ts) and ` +
      'legacyNames (core/cookies.ts), their tests and the sentences describing the fallback, then delete this test.').toEqual([]);
  });

  it.each(['0.4.0', '0.10.0', '1.0.9'])('may stay in %s', (earlier) => {
    expect(overdue(earlier, sources)).toEqual([]);
  });

  // Also fails when an identifier is renamed, which would otherwise pass the check above without a word.
  it.each(['1.1.0', '1.1.1', '1.2.0', '2.0.0'])('is found in both sources at %s', (later) => {
    expect(overdue(later, sources)).toEqual(['service.ts', 'cookies.ts']);
  });

  it('is not reported once neither source holds it', () => {
    expect(overdue('1.1.0', { 'service.ts': '', 'cookies.ts': '' })).toEqual([]);
  });
});

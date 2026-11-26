// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Single-gym installs read the old cookie names only before 1.1.0: remove the fallback, its tests and the
// sentences describing it, then delete this test.
const identifiers = { 'service.ts': 'legacySessionCookies', 'cookies.ts': 'legacyNames' } as const;
type Sources = Record<keyof typeof identifiers, string>;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(read('../../../../../package.json')) as { version: string };
const sources: Sources = { 'service.ts': read('./service.ts'), 'cookies.ts': read('../../core/cookies.ts') };

/** From version 1.1 on, the names of the sources that still hold their fallback identifier; none before it. */
function overdue(version: string, sources: Sources): string[] {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10)) as [number, number];
  if (major < 1 || (major === 1 && minor < 1)) return [];
  return (Object.keys(identifiers) as (keyof Sources)[]).filter((name) => sources[name].includes(identifiers[name]));
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

// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/** Variables the running server or a `gym-app` command reads: tests, fixtures and browser checks are left out. */
function serverVariables(): Set<string> {
  const files = globSync(['apps/server/src/**/*.ts', 'packages/db/src/**/*.ts'], { cwd: root })
    .map((file) => file.replaceAll('\\', '/'))
    .filter((file) => !/\.test\.tsx?$|\.test-helper\.ts$|\/testing\/|\/scenarios\/|vitest\.[^/]*config\.ts$/.test(file));
  const names = new Set<string>();
  for (const file of files) {
    const source = read(file);
    for (const [, name] of source.matchAll(/\b(?:process\.env|env)(?:\.|\[')([A-Z][A-Z0-9_]+)/g)) names.add(name!);
    for (const [, name] of source.matchAll(/\brequired\((?:env, )?'([A-Z][A-Z0-9_]+)'\)/g)) names.add(name!);
  }
  return names;
}
/** Variables the deployment Compose file interpolates, and those the image's start-up scripts read. */
function composeVariables(): Set<string> {
  const sources = ['deploy/compose.yaml', ...globSync('deploy/container/*.sh', { cwd: root })];
  return new Set(sources.flatMap((file) => [...read(file).matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)].map(([, name]) => name!)));
}
/** The variables named in the first column of configuration.md's tables. */
function documentedVariables(): Set<string> {
  return new Set(read('docs/configuration.md').split('\n')
    .flatMap((line) => /^\| `([A-Z][A-Z0-9_]+)` \|/.exec(line)?.[1] ?? []));
}

describe('docs/configuration.md', () => {
  it('lists every variable the server reads', () => {
    const documented = documentedVariables();
    expect([...serverVariables()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });
  it('lists every variable the deployment Compose file uses', () => {
    const documented = documentedVariables();
    expect([...composeVariables()].filter((name) => !documented.has(name)).sort()).toEqual([]);
  });
  it('lists only variables something still reads', () => {
    const used = new Set([...serverVariables(), ...composeVariables()]);
    expect([...documentedVariables()].filter((name) => !used.has(name)).sort()).toEqual([]);
  });
  it('finds the variables it checks', () => {
    // A broken scan would pass the checks above vacuously.
    expect(serverVariables()).toContain('APP_ENCRYPTION_KEY');
    expect(serverVariables()).toContain('BACKUP_STAGING_DIR');
    expect(composeVariables()).toContain('APP_IMAGE');
    expect(documentedVariables().size).toBeGreaterThan(40);
  });
});

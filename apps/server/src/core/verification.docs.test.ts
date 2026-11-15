// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createVitest } from 'vitest/node';
import { isFile, parseTestImports, resolveTestImport, testSupport, usesDatabase } from '../../../../scripts/test-imports.js';
import { documentationTests, runDocumentationTests } from '../../../../scripts/test-selection.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
// These read recorded responses, locale expectations, or files written by the test itself.
// A new source reader must be in verify's always-run list (or be a *.docs.test.ts).
const fixtureReaders = new Set([
  'apps/server/src/areas/billing/packs/ledger-writers.test.ts',
  'apps/server/src/areas/billing/runner/runner.collection.test.ts',
  'apps/server/src/areas/billing/signed-link-checkout.runtime.test.ts',
  'apps/server/src/areas/billing/signed-link-checkout.test.ts',
  'apps/server/src/areas/billing/transitions/transitions.test.ts',
  'apps/server/src/areas/billing/webhooks/handlers/handlers.test.ts',
  'apps/server/src/areas/health/backups.files.test.ts',
  'apps/server/src/areas/health/restore.failure.test.ts',
  'apps/server/src/areas/health/restore.gate.test.ts',
  'apps/server/src/areas/health/restore.gate-process.test.ts',
  'apps/server/src/areas/health/restore.gate-monitor.test.ts',
  'apps/server/src/areas/health/restore.resume.test.ts',
  'apps/server/src/areas/links/campaigns.scale.test.ts',
  'apps/server/src/areas/links/campaigns.test.ts',
  'apps/server/src/areas/links/service.test.ts',
  'apps/server/src/areas/setup/setup.restore.test.ts',
  'apps/server/src/cli/restore.files.test.ts',
  'apps/server/src/emails/links/service.test.ts',
  'apps/server/src/infra/payments/stripe.test.ts',
  'apps/server/src/infra/storage/storage.index.test.ts',
  'apps/server/src/infra/storage/storage.test.ts',
  'apps/server/test/boot.test.ts',
  'packages/db/src/testing/database-upgrade.test.ts',
]);

/** Inspect filesystem imports, including aliases/namespaces and transitive test helpers. */
function fileReader(file: string, readSource = read, visiting = new Set<string>(), exists: (file: string) => boolean = isFile): boolean {
  if (visiting.has(file)) return false;
  visiting.add(file);
  return parseTestImports(file, readSource(file)).references.some(({ specifier, readsFiles }) => {
    if (readsFiles) return true;
    const helper = testSupport(specifier) ? resolveTestImport(resolve(root, file), specifier, exists) : undefined;
    return helper !== undefined && fileReader(relative(root, helper).replaceAll('\\', '/'), readSource, visiting, exists);
  });
}

describe('verification discovery', () => {
  it('shares the test and compliance bodies with the public package scripts', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    const verify = read('scripts/verify.mjs');
    for (const name of ['test', 'compliance']) {
      expect(scripts[name]).toBe(`pnpm generate && pnpm ${name}:run`);
      expect(scripts[`${name}:run`]).toBeTruthy();
      expect(verify).toContain(`pnpm('${name}:run'`);
    }
  });
  it('requires file-reading tests to declare how selected verification covers them', async () => {
    const list = /const sourceScanningTests = \[([\s\S]*?)\];/.exec(read('scripts/verify.mjs'));
    expect(list).not.toBeNull();
    const scanning = new Set([...list![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!));
    // A selected verify run must still check the full inventory, including other projects.
    vi.stubEnv('PLAINGYM_TEST_FILES', undefined);
    let vitest;
    let specifications;
    try {
      vitest = await createVitest('test', { root, watch: false, run: true, reporters: [] });
      specifications = await vitest.globTestSpecifications();
    } finally {
      vi.unstubAllEnvs();
      await vitest?.close();
    }
    const files = [...new Set(specifications.map(spec => relative(root, spec.moduleId).replaceAll('\\', '/')))];
    expect(specifications.find(spec => spec.moduleId.replaceAll('\\', '/').endsWith('/packages/db/src/testing/database-upgrade.test.ts'))?.project.name).toBe('integration');
    documentationTests(specifications);
    const uncovered = files.filter(file => !/\.docs\.test\.ts$/.test(file) && !scanning.has(file) && !fixtureReaders.has(file)
      && fileReader(file));
    expect(uncovered, 'Add source scanners to scripts/verify.mjs; classify fixture-only reads explicitly here').toEqual([]);
    for (const file of scanning) expect(files).toContain(file);
    for (const file of fixtureReaders) expect(files).toContain(file);
  });
  it.each([
    "import { globSync as files } from 'node:fs';",
    "import { createReadStream } from 'node:fs';",
    "import * as files from 'node:fs/promises';",
    "import { readFile as read } from 'node:fs/promises';",
    "import { promises as files } from 'node:fs';",
    "const files = await import('node:fs');",
    "const { readFile } = await import('node:fs/promises');",
    "export { readFile as read } from 'node:fs/promises';",
  ])('recognizes filesystem readers: %s', source => {
    expect(fileReader('fixture.test.ts', () => source)).toBe(true);
  });
  it('ignores fixture writers and reader names mentioned only as text', () => {
    expect(fileReader('fixture.test.ts', () => "import { writeFile } from 'node:fs/promises'; const text = 'readFile';")).toBe(false);
  });
  it('follows file reads through test helpers', () => {
    // This existing helper provides a real path for resolution; contents are supplied by the fixture.
    expect(fileReader('apps/server/src/core/fixture.test.ts', file => file.endsWith('.test-helper.ts')
      ? "import { globSync } from 'node:fs';" : "import { fixture } from './runtime.fixture.test-helper.js';")).toBe(true);
  });
  it.each(['.js', '.mjs', '.ts'])('follows database re-exports through %s helpers', extension => {
    const file = resolve(root, 'fixture.test.ts'), helper = resolve(root, 'nested.test-helper.ts');
    const sources = new Map([[file, `export * from './nested.test-helper${extension}';`],
      [helper, "export { useTestDatabase } from '@plaingym/db/testing/database';"]]);
    expect(usesDatabase(file, path => sources.get(path)!, path => sources.has(path))).toBe(true);
  });
  it('ignores type-only helper and database imports', () => {
    expect(usesDatabase('fixture.test.ts', () => "export type { X } from '@plaingym/db/testing/database'; import { type Y } from '@plaingym/db/testing/database';")).toBe(false);
    expect(fileReader('fixture.test.ts', () => "import type { readFile } from 'node:fs';")).toBe(false);
  });
  it('resolves JavaScript fixture modules without a test-helper suffix', () => {
    const sources = new Map([['example.test.ts', "import { read } from './fixture.mjs';"],
      ['fixture.mjs', "const fs = await import('node:fs/promises');"]]);
    expect(fileReader('example.test.ts', file => sources.get(file)!, new Set(),
      file => sources.has(relative(root, file).replaceAll('\\', '/')))).toBe(true);
  });
  it('traverses helper cycles without losing database use on either side', () => {
    const a = resolve(root, 'a.test-helper.ts'), b = resolve(root, 'b.test-helper.ts');
    const sources = new Map([[a, "export * from './b.test-helper.js'; export * from '@plaingym/db/testing/database';"],
      [b, "export * from './a.test-helper.js';"]]);
    for (const file of [a, b]) expect(usesDatabase(file, path => sources.get(path)!, path => sources.has(path))).toBe(true);
  });
  it('uses the specifications Vitest discovered, including docs outside apps and packages', () => {
    const docs = { moduleId: '/repo/e2e/example.docs.test.ts', project: { name: 'unit' } };
    const ordinary = { moduleId: '/repo/apps/example.test.ts', project: { name: 'integration' } };
    expect(documentationTests([ordinary, docs])).toEqual([docs]);
    expect(documentationTests([docs])[0]).toBe(docs);
  });
  it('fails when discovery finds no docs tests', () => {
    expect(() => documentationTests([])).toThrow('No documentation tests found');
  });
  it('rejects docs assigned to the database project before executing anything', () => {
    expect(() => documentationTests([{ moduleId: '/repo/misplaced.docs.test.ts', project: { name: 'integration' } }]))
      .toThrow('Documentation tests must belong to unit: /repo/misplaced.docs.test.ts');
  });
  it('runs the discovered docs on the same instance exactly once', async () => {
    const docs = { moduleId: '/repo/e2e/example.docs.test.ts', project: { name: 'unit' } };
    const vitest = { globTestSpecifications: vi.fn(async () => [docs, { moduleId: '/repo/other.test.ts', project: { name: 'integration' } }]),
      standalone: vi.fn(async () => {}),
      runTestSpecifications: vi.fn(async (_specifications: typeof docs[]) => ({ unhandledErrors: [], testModules: [{ state: () => 'passed' }] })) };
    expect(await runDocumentationTests(vitest)).toBe(true);
    expect(vitest.globTestSpecifications).toHaveBeenCalledTimes(1);
    expect(vitest.standalone).toHaveBeenCalledTimes(1);
    expect(vitest.standalone.mock.invocationCallOrder[0]).toBeLessThan(vitest.runTestSpecifications.mock.invocationCallOrder[0]!);
    expect(vitest.runTestSpecifications).toHaveBeenCalledExactlyOnceWith([docs]);
    expect(vitest.runTestSpecifications.mock.calls[0]![0]![0]).toBe(docs);
  });
  it.each([
    { state: 'failed', unhandledErrors: [] }, { state: 'passed', unhandledErrors: [new Error('worker failed')] },
  ])('reports failure for a $state module and $unhandledErrors', async ({ state, unhandledErrors }) => {
    expect(await runDocumentationTests({
      globTestSpecifications: async () => [{ moduleId: '/repo/example.docs.test.ts', project: { name: 'unit' } }],
      standalone: async () => {},
      runTestSpecifications: async () => ({ unhandledErrors, testModules: [{ state: () => state }] }),
    })).toBe(false);
  });
  it('refuses an empty run instead of treating missing modules as passing', async () => {
    await expect(runDocumentationTests({
      globTestSpecifications: async () => [{ moduleId: '/repo/example.docs.test.ts', project: { name: 'unit' } }],
      standalone: async () => {},
      runTestSpecifications: async () => ({ unhandledErrors: [], testModules: [] }),
    })).rejects.toThrow('Not every documentation test module ran');
  });
});

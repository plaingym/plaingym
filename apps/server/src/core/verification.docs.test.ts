// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
  'packages/db/src/' + 'testing/' + 'database-upgrade.test.ts',
]);

describe('verification discovery', () => {
  it('requires file-reading tests to declare how selected verification covers them', () => {
    const list = /const sourceScanningTests = \[([\s\S]*?)\];/.exec(read('scripts/verify.mjs'));
    expect(list).not.toBeNull();
    const scanning = new Set([...list![1]!.matchAll(/'([^']+)'/g)].map(match => match[1]!));
    const files = globSync(['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts', 'e2e/*.test.ts'],
      { cwd: root, exclude: ['**/node_modules/**'] }).map(file => file.replaceAll('\\', '/'));
    const uncovered = files.filter(file => !/\.docs\.test\.ts$/.test(file) && !scanning.has(file) && !fixtureReaders.has(file)
      && /\b(?:readFile(?:Sync)?|readdir(?:Sync)?)\b/.test(read(file)));
    expect(uncovered, 'Add source scanners to scripts/verify.mjs; classify fixture-only reads explicitly here').toEqual([]);
    for (const file of scanning) expect(files).toContain(file);
    for (const file of fixtureReaders) expect(files).toContain(file);
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

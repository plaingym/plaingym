// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync, globSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests never read the developer's .env: an existing test server is used only when named explicitly
// (TEST_DATABASE_URL, see apps/server/test/setup-database.ts); otherwise a disposable PostgreSQL starts.
// `pnpm verify` names the affected test files in PLAINGYM_TEST_FILES (one per line).
const selected = process.env.PLAINGYM_TEST_FILES
  ? new Set(readFileSync(process.env.PLAINGYM_TEST_FILES, 'utf8').split('\n').filter(Boolean)) : null;
const files = globSync(['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'], { exclude: ['**/node_modules/**'] })
  .map((file) => file.replaceAll('\\', '/')).filter((file) => !selected || selected.has(file));
/**
 * A test file needs the database when it uses the test database helpers or the injected template, or when a
 * `*.test-helper.ts` it imports (directly or through another helper) does. Only static `from './x.test-helper.js'`
 * imports are followed; a file that reaches the database any other way names the helpers itself.
 */
const helperUsesDatabase = new Map<string, boolean>();
function usesDatabase(file: string, visiting = new Set<string>()): boolean {
  const known = helperUsesDatabase.get(file);
  if (known !== undefined) return known;
  if (visiting.has(file)) return false; // A helper import cycle ends here.
  visiting.add(file);
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const result = /@plaingym\/db\/testing|testing\/database|inject\(['"]testDatabase['"]\)/.test(source)
    || [...source.matchAll(/from '(\.[^']*\.test-helper)(?:\.js)?'/g)].some(([, specifier]) => {
      const helper = ['.ts', '.tsx'].map((extension) => resolve(dirname(file), specifier + extension)).find(existsSync);
      return helper !== undefined && usesDatabase(helper, visiting);
    });
  visiting.delete(file);
  // A `false` reached inside a cycle can still turn `true` once the cycle's first file is answered, so only that answer is kept.
  if (result || !visiting.size) helperUsesDatabase.set(file, result);
  return result;
}
const integration = files.filter((file) => usesDatabase(file)), unit = files.filter((file) => !integration.includes(file));

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
    setupFiles: ['./apps/server/test/quiet-logs.ts'],
    // Changes that tests read without importing them. In `pnpm verify`, any of these runs every test.
    // Locale JSON isn't one: `pnpm generate` validates it, and CI runs the tests that assert its text.
    forceRerunTriggers: [
      '**/package.json', '**/pnpm-lock.yaml', '**/{vitest,vite}.config.*', '**/apps/server/test/**',
      '**/packages/db/src/migrations/**', '**/locales/*.ts', '**/scripts/generate*.mjs', '**/compose.{dev,test}.yaml', '**/dev/postgres/**',
    ],
    projects: [
      // `pnpm test:unit` runs these without Docker or a database.
      { extends: true, test: { name: 'unit', include: unit } },
      { extends: true, test: { name: 'integration', include: integration, globalSetup: ['./apps/server/test/setup-database.ts'] } },
    ],
  },
});

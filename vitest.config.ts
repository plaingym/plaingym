// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, globSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Tests never read the developer's .env: an existing test server is used only when named explicitly
// (TEST_DATABASE_URL, see apps/server/test/setup-database.ts); otherwise a disposable PostgreSQL starts.
// `pnpm verify` names the affected test files in PLAINGYM_TEST_FILES (one per line).
const selected = process.env.PLAINGYM_TEST_FILES
  ? new Set(readFileSync(process.env.PLAINGYM_TEST_FILES, 'utf8').split('\n').filter(Boolean)) : null;
const files = globSync(['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'], { exclude: ['**/node_modules/**'] })
  .map((file) => file.replaceAll('\\', '/')).filter((file) => !selected || selected.has(file));
/** A test file needs the database when it uses the test database helpers or the injected template. */
const usesDatabase = (file: string) => /@plaingym\/db\/testing|testing\/database|inject\(['"]testDatabase['"]\)/.test(readFileSync(file, 'utf8'));
const integration = files.filter(usesDatabase), unit = files.filter((file) => !integration.includes(file));

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

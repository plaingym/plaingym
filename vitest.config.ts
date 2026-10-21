// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const envFile = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./apps/server/test/setup-database.ts'],
    include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    clearMocks: true,
  },
});

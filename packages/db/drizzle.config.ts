// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'postgresql', schema: './src/schema/index.ts', out: './src/migrations',
  migrations: { prefix: 'index' },
});

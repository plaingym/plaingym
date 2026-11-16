// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';
import base from '../playwright.config.js';

export default defineConfig({ ...base, testDir: '.', testMatch: '**/product.spec.ts',
  projects: [{ name: 'product-capture' }], timeout: 12 * 60_000, globalTimeout: 15 * 60_000,
  outputDir: '../coverage/product-results', reporter: [['list']],
  use: { ...base.use, trace: 'off', screenshot: 'off', video: 'off' },
});

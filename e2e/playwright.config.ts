// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  projects: process.env.E2E_VM_CONFIG ? [{ name: 'vm', testMatch: '**/vm.spec.ts' }] : [
    { name: 'fresh-setup', testMatch: '**/fresh-setup.spec.ts' },
    { name: 'members-mat', testMatch: '**/*.spec.ts', testIgnore: ['**/vm.spec.ts', '**/fresh-setup.spec.ts'], dependencies: ['fresh-setup'] },
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  forbidOnly: true,
  outputDir: './coverage/results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './coverage/report' }]],
  use: {
    browserName: 'chromium',
    actionTimeout: 15_000,
    channel: process.env.E2E_BROWSER_CHANNEL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1024, height: 768 },
    timezoneId: 'UTC',
    // VM wizard fields include backup credentials and the one-time age key.
    trace: process.env.E2E_VM_CONFIG ? 'off' : 'retain-on-failure',
    screenshot: process.env.E2E_VM_CONFIG ? 'off' : 'only-on-failure',
    launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'] },
  },
});

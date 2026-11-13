// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from '@playwright/test';

const loopback = process.env.E2E_LOOPBACK ?? '127.0.0.1';
// The UX pass (`ux-pass/README.md`) runs alone on a fresh stack: it walks the setup wizard itself, then the other browsers
// reach the stack through a local proxy (`ux-pass/proxy.ts`), since only Chromium takes the host-resolver flag. The proxy is
// the browser's own, not a context's, so Firefox can't send *.localhost around it; its port follows the loopback address.
const uxProxyPort = process.env.E2E_UX_PROXY_PORT ??= String(30000 + Number(loopback.split('.').pop()));
const uxBrowser = (browserName: 'firefox' | 'webkit') => ({ name: 'ux-' + browserName, testDir: './ux-pass', testMatch: '**/browsers.spec.ts',
  dependencies: ['ux-pass'], use: { browserName, channel: undefined, launchOptions: { proxy: { server: 'http://127.0.0.1:' + uxProxyPort },
    // Firefox never proxies *.localhost unless told to, and would resolve it to 127.0.0.1 itself.
    ...browserName === 'firefox' ? { firefoxUserPrefs: { 'network.proxy.allow_hijacking_localhost': true } } : {} } } });
const uxProjects = [{ name: 'ux-pass', testMatch: '**/ux-pass.spec.ts' }, uxBrowser('firefox'), uxBrowser('webkit')];

export default defineConfig({
  testDir: './specs',
  projects: process.env.E2E_VM_CONFIG ? [{ name: 'vm', testMatch: '**/vm.spec.ts' }] : process.env.UX_PASS === '1' ? uxProjects : [
    { name: 'fresh-setup', testMatch: '**/fresh-setup.spec.ts' },
    { name: 'members-mat', testMatch: '**/*.spec.ts', testIgnore: ['**/vm.spec.ts', '**/fresh-setup.spec.ts', '**/ux-pass.spec.ts'], dependencies: ['fresh-setup'] },
    // Two gyms of one multi-gym install (not demo mode), on their own hostnames.
    { name: 'multi-gym', testDir: './multi', testMatch: '**/*.spec.ts' },
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
    // ignoreHTTPSErrors does not cover service worker scripts; the portal's installability check registers one.
    launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP *.localhost ' + loopback, '--ignore-certificate-errors'] },
  },
});

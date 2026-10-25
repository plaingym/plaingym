// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { Client, gymOrigin } from '../support.js';

// The fresh-setup project runs before any test can initialize the install fixture.
test('fresh setup has successful disabled discovery and no demo alert before owner creation', async ({ page }) => {
  const guest = new Client(gymOrigin);
  expect((await guest.json<{ data: { currentStep: number; completed: boolean } }>('/api/setup')).data)
    .toMatchObject({ currentStep: 0, completed: false });
  const probes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/demo' || path === '/api/demo/status') probes.push(path);
  });
  for (const width of [360, 1280]) {
    await page.goto('about:blank');
    await page.setViewportSize({ width, height: 800 });
    const discovery = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/demo');
    await page.goto(gymOrigin + '/setup#token=' + process.env.E2E_SETUP_TOKEN);
    const response = await discovery;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ data: { mode: 'disabled' } });
    await expect(page.getByRole('heading', { name: 'Start fresh or restore a backup', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your owner account', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  expect(probes).toEqual(['/api/demo', '/api/demo']);
  // Advancing to the owner form leaves the empty install available to the API fixture.
  expect((await guest.json<{ data: { currentStep: number } }>('/api/setup')).data.currentStep).toBe(0);
});


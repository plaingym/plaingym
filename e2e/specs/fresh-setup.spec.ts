// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '@playwright/test';
import { Client, gymOrigin, password } from '../support.js';
import { accessibleLayout, reachable, sizes } from '../responsive.js';

// The fresh-setup project runs before any test can initialize the install fixture.
test('phone-first fresh wizard completes with disabled discovery, reachable actions and axe A/AA at three sizes', async ({ page }, info) => {
  test.setTimeout(240_000);
  const guest = new Client(gymOrigin);
  expect((await guest.json<{ data: { currentStep: number; completed: boolean } }>('/api/setup')).data)
    .toMatchObject({ currentStep: 0, completed: false });
  const probes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/demo' || path === '/api/demo/status') probes.push(path);
  });
  for (const { width, height } of sizes) {
    await page.goto('about:blank');
    await page.setViewportSize({ width, height });
    const discovery = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/demo');
    await page.goto(gymOrigin + '/setup#token=' + process.env.E2E_SETUP_TOKEN);
    const response = await discovery;
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ data: { mode: 'disabled' } });
    await expect(page.getByRole('heading', { name: 'Start fresh or restore a backup', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
    await accessibleLayout(page, info, 'start-' + width);
    await page.getByRole('button', { name: 'Restore a backup', exact: true }).click();
    await expect(page.getByLabel('Snapshot ID or snapshots/ID/ prefix')).toBeVisible();
    await reachable(page.getByRole('button', { name: 'Restore a backup', exact: true }), page);
    await accessibleLayout(page, info, 'restore-' + width);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Create your owner account', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await accessibleLayout(page, info, 'owner-' + width);
  }
  expect(probes).toEqual(['/api/demo', '/api/demo', '/api/demo']);
  expect((await guest.json<{ data: { currentStep: number } }>('/api/setup')).data.currentStep).toBe(0);
  const checkStep = async (name: string, action: string) => {
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.evaluate(() => scrollTo(0, 0));
      await reachable(page.getByRole('button', { name: action, exact: true }), page);
      const actions = page.getByRole('group', { name: 'Setup actions', exact: true });
      await expect(actions).toHaveCount(1);
      for (const button of await actions.getByRole('button').all()) await reachable(button, page);
      await accessibleLayout(page, info, name + '-' + size.width);
      await page.screenshot({ path: info.outputPath(name + '-' + size.width + '.png'), fullPage: true });
    }
    await page.setViewportSize(sizes[0]!);
  };
  await checkStep('owner', 'Save and continue');
  await page.getByLabel('Your name', { exact: true }).fill('QA Owner');
  await page.getByLabel('Email address', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('Password (12–128 characters)', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Gym details', exact: true })).toBeVisible();
  await checkStep('gym', 'Save and continue');
  // An invalid save stays on this screen and preserves the owner's input.
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.getByLabel('Gym name', { exact: true })).toBeFocused();
  await page.getByLabel('Gym name', { exact: true }).fill('QA academy');
  await page.getByLabel('IANA timezone', { exact: true }).fill('UTC');
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ })).toBeVisible();
  await checkStep('packs', 'Save and continue');
  await page.getByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ }).check();
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your website', exact: true })).toBeVisible();
  await checkStep('website', 'Save and continue');
  await page.getByRole('radio', { name: 'I already have a website', exact: true }).check();
  await page.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email delivery', exact: true })).toBeVisible();
  await checkStep('email', 'Send test email and save');
  await page.getByRole('button', { name: 'Skip email configuration', exact: true }).click();
  // The payments step belongs to the payment integration; exercise its existing skip unchanged.
  await expect(page.getByLabel('Restricted Stripe key', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Set up later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Protect your gym with backups', exact: true })).toBeVisible();
  await checkStep('backups', 'Generate backup key');
  await page.getByRole('button', { name: 'Set up later', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import or start fresh', exact: true })).toBeVisible();
  await checkStep('finish', 'Start fresh');
  await page.getByRole('button', { name: 'Import a CSV', exact: true }).click();
  await expect(page.getByLabel('CSV file (UTF-8, up to 20 MB)', { exact: true })).toBeVisible();
  await checkStep('import', 'Back');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Start fresh', exact: true }).click();
  await expect(page.getByText('Setup is complete. Billing and member emails are off until you turn them on.', { exact: true })).toBeVisible();
  expect(probes).toEqual(['/api/demo', '/api/demo', '/api/demo']);
});


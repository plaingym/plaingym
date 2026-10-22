// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createWebRegistries } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';

it('registers web slots with feature translation namespaces', async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../../web/src/lib/registries.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  const source = result.outputFiles[0]!.text;
  const module = await import(
    'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
  );
  const registries: ReturnType<typeof createWebRegistries<unknown>> = module.createRegistries();
  expect(registries.memberTabs.all().map((entry) => entry.id)).toEqual(
    expect.arrayContaining([
      'memberTabs.attendance',
      'memberTabs.bookings',
      'memberTabs.checkin-code',
      'memberTabs.invoices',
      'memberTabs.membership',
      'memberTabs.portal-access',
      'memberTabs.ranks',
      'memberTabs.waivers',
    ]),
  );
  expect(registries.sessionPanels.all().length).toBeGreaterThanOrEqual(2);
  expect(registries.settingsSections.all().length).toBeGreaterThanOrEqual(6);
  expect(registries.portalPages.all().length).toBeGreaterThanOrEqual(6);
  expect(registries.portalNav.all().length).toBeGreaterThanOrEqual(6);
  expect(registries.setupSteps.all().length).toBeGreaterThanOrEqual(2);
  expect(registries.adminNav.all().length).toBeGreaterThan(10);
  for (const registry of Object.values(registries)) {
    expect(registry.all().every((entry) => typeof entry.enabled === 'boolean')).toBe(true);
    for (const entry of registry.all())
      expect(locales.en).toHaveProperty(entry.labelKey.split(':')[0]!);
  }
  expect(registries.settingsSections.forModules(new Set()).some((entry) => entry.moduleId)).toBe(
    false,
  );
});

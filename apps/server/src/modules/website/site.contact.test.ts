// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { renderSitePage } from './site.page.js';

it('directs owners to missing address and public contact settings', () => {
  const html = renderSitePage({ page: 'contact', t: createTranslator(locales.en ?? {}), origin: 'https://gym.example.test', nonce: 'test', site: {
    gym: { name: 'Academy', revision: 1, timezone: 'UTC', address: {}, logoVersion: null, primaryColor: null, updatedAt: '2026-11-13T00:00:00Z' },
    content: { tagline: null, about: null, phone: null, email: null, accentColor: null, photos: [] },
    programs: [], classes: [], sessions: [], plans: [], coaches: [],
  } });
  expect(html).toContain('Settings → Gym details'); expect(html).toContain('Settings → Website');
  expect(html).not.toContain('href="tel:'); expect(html).not.toContain('href="mailto:');
});

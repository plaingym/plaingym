// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { renderSitePage } from './site.page.js';

const fallback = 'Use the links below to try a class or join.';
const render = (phone: string | null, address: Record<string, string> = {}) => renderSitePage({ page: 'contact', t: createTranslator(locales.en ?? {}), origin: 'https://gym.example.test', nonce: 'test', site: {
  gym: { name: 'Academy', revision: 1, timezone: 'UTC', address, logoVersion: null, primaryColor: null, updatedAt: '2026-11-13T00:00:00Z' },
  content: { tagline: null, about: null, phone, email: null, accentColor: null, photos: [] },
  programs: [], classes: [], sessions: [], plans: [], coaches: [],
} });

it.each([null, '+1 (604) 555-0100'])('shows visitor-facing contact text with phone %s', phone => {
  const html = render(phone);
  expect(html).not.toContain('Gym owners:'); expect(html).not.toContain('Settings');
  if (phone) {
    expect(html).toContain('href="tel:+16045550100"');
    expect(html).not.toContain(fallback);
  } else {
    expect(html).toContain(fallback);
    expect(html).not.toContain('href="tel:');
  }
  expect(html).not.toContain('href="mailto:');
});
it('keeps the contact card from rendering empty when only an address is published', () => {
  const html = render(null, { line1: '1 Main St', city: 'North' });
  expect(html).toContain('1 Main St'); expect(html).not.toContain('The address has not been added yet.');
  expect(html).toContain(fallback);
  expect(html).not.toContain('Gym owners:'); expect(html).not.toContain('Settings');
});

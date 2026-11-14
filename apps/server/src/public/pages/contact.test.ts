// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { publicLayout } from './page.js';
import { jsx } from 'hono/jsx';

const t = createTranslator(locales.en ?? {});
const gym = { name: 'North <Gym>', revision: 1, logoKey: null, primaryColor: null };
it('tells owners where to add missing public details without making up a contact link', () => {
  const html = publicLayout({ gym, title: 'Contact', t, content: jsx('p', null, 'Welcome') });
  expect(html).toContain('Contact details have not been added yet.');
  expect(html).toContain('Settings → Gym details'); expect(html).toContain('Settings → Website');
  expect(html).not.toContain('href="tel:'); expect(html).not.toContain('href="mailto:');
});
it('escapes address text and wraps long public contacts', () => {
  const html = publicLayout({ gym: { ...gym, address: { line1: '<script>bad()</script>', city: 'North' }, phone: '+1 (604) 555-0100', email: 'public@example.test' }, title: 'Contact', t, content: jsx('p', null, 'Welcome') });
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(html).not.toContain('<script>bad()');
  expect(html).toContain('href="tel:+16045550100"'); expect(html).toContain('href="mailto:public@example.test"');
  expect(html).toContain('break-all'); expect(html).toContain('min-h-11');
});

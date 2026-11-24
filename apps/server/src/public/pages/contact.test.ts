// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { publicLayout } from './page.js';
import { jsx } from 'hono/jsx';

const t = createTranslator(locales.en ?? {});
const gym = { name: 'North <Gym>', revision: 1, logoKey: null, primaryColor: null };
it('shows visitor guidance with no contact details without making up a contact link', () => {
  const html = publicLayout({ gym, title: 'Contact', t, content: jsx('p', null, 'Welcome') });
  expect(html).toContain('Contact details have not been added yet.');
  expect(html).not.toContain('Gym owners:'); expect(html).not.toContain('Settings');
  expect(html).not.toContain('href="tel:'); expect(html).not.toContain('href="mailto:');
});
it.each(['/join', '/trial', '/drop-in'])('shows only the published phone on the shared %s shell', path => {
  const html = publicLayout({ gym: { ...gym, phone: '+1 (604) 555-0100' }, title: path, t, content: jsx('p', null, 'Welcome') });
  expect(html).toContain('href="tel:+16045550100"');
  expect(html).not.toContain('Contact details have not been added yet.');
  expect(html).not.toContain('Gym owners:'); expect(html).not.toContain('Settings');
  expect(html).not.toContain('href="mailto:');
});
it('escapes address text and wraps long public contacts', () => {
  const html = publicLayout({ gym: { ...gym, address: { line1: '<script>bad()</script>', city: 'North' }, phone: '+1 (604) 555-0100', email: 'public@example.test' }, title: 'Contact', t, content: jsx('p', null, 'Welcome') });
  expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;'); expect(html).not.toContain('<script>bad()');
  expect(html).toContain('href="tel:+16045550100"'); expect(html).toContain('href="mailto:public@example.test"');
  expect(html).toContain('break-all'); expect(html).toContain('min-h-11');
});
it('passes the page translator to the footer version label and keeps English by default', () => {
  expect(publicLayout({ gym, title: 'Contact', t, content: jsx('p', null, 'Welcome') })).toContain('<span class="sr-only">Version </span>');
  const probe = createTranslator({ ...locales.en, 'shell/shell': { ...locales.en?.['shell/shell'], versionPrefix: 'Probe' } });
  expect(publicLayout({ gym, title: 'Contact', t: probe, content: jsx('p', null, 'Welcome') })).toContain('<span class="sr-only">Probe </span>');
});

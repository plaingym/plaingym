// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { renderAuthLink, templates } from './auth.js';

it('renders translated login mail as escaped HTML and plain text', async () => {
  const t = createTranslator({ 'staff/auth': { subject: 'Login', description: 'Hello <member>', button: 'Open link' } });
  const url = 'https://gym.example.test/api/auth/magic-link/verify?token=test&callbackURL=%2Fadmin';
  const result = renderAuthLink(url, t);
  expect(result.subject).toBe('Login');
  expect(result.html).toContain('Hello &lt;member&gt;'); expect(result.html).toContain('&amp;callbackURL=');
  expect(result.text).toBe(`Hello <member>\n\nOpen link: ${url}`);
  expect(await templates[0]!.render({ url }, t)).toEqual(result);
  expect(() => renderAuthLink('javascript:alert(1)', t)).toThrow('Invalid login URL');
  await expect(templates[0]!.render({}, t)).rejects.toThrow('Expected login URL');
});

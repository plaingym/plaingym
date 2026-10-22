// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { createTranslator } from '@plaingym/shared';
import { describe, expect, it } from 'vitest';
import { EmailButton, EmailHeading, EmailText, renderEmail } from './index.js';

const t = createTranslator({ 'staff/auth': {
  subject: 'Sign in to {gym}', preview: 'Your secure link', heading: 'Welcome, {name}',
  body: 'Use the link below to sign in.', action: 'Sign in', footer: 'Sent by {gym}.',
} });

describe('shared email layout', () => {
  it('renders translated header, footer, typography and button as HTML and plain text', async () => {
    const result = await renderEmail({ gymName: 'Test Academy', t, subjectKey: 'staff/auth:subject',
      subjectValues: { gym: 'Test Academy' }, previewKey: 'staff/auth:preview', footerKey: 'staff/auth:footer',
      footerValues: { gym: 'Test Academy' }, children: [
        createElement(EmailHeading, { key: 'heading', t, messageKey: 'staff/auth:heading', values: { name: 'Alex' } }),
        createElement(EmailText, { key: 'body', t, messageKey: 'staff/auth:body' }),
        createElement(EmailButton, { key: 'button', t, messageKey: 'staff/auth:action', href: 'https://gym.example.test/login?token=abc&gym=a' }),
      ] });
    expect(result.subject).toBe('Sign in to Test Academy');
    expect(result.html).toContain('<html');
    expect(result.html).toContain('lang="en"');
    expect(result.html).toContain('Welcome, Alex');
    expect(result.html).toContain('Sent by Test Academy.');
    expect(result.html).toContain('href="https://gym.example.test/login?token=abc&amp;gym=a"');
    expect(result.html).toContain('Your secure link');
    expect(result.text).toContain('Test Academy');
    expect(result.text).toContain('Welcome, Alex');
    expect(result.text).toContain('Use the link below to sign in.');
    expect(result.text).toContain('https://gym.example.test/login?token=abc&gym=a');
    expect(result.text).toContain('Sent by Test Academy.');
    expect(result.text).not.toMatch(/<\/?(?:html|p|a|table)\b/);
  });

  it('escapes interpolated values and supports a caller-provided locale', async () => {
    const translated = createTranslator({ 'staff/auth': { subject: 'Connexion', heading: 'Bonjour {name}', footer: 'Envoy\u00e9 par {gym}.' } });
    const result = await renderEmail({ gymName: '<script>gym()</script>', language: 'fr', t: translated,
      subjectKey: 'staff/auth:subject', footerKey: 'staff/auth:footer', footerValues: { gym: 'Acad\u00e9mie' },
      children: createElement(EmailHeading, { t: translated, messageKey: 'staff/auth:heading', values: { name: '<script>alert(1)</script>' } }) });
    expect(result.html).toContain('lang="fr"');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.text).toContain('Bonjour <script>alert(1)</script>');
    expect(result.text).toContain('Envoy\u00e9 par Acad\u00e9mie.');
  });

  it('rejects unsafe button URLs and injected subject headers', async () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@gym.example.test', '/relative'])
      expect(() => EmailButton({ t, messageKey: 'staff/auth:action', href })).toThrow();
    const malicious = createTranslator({ 'staff/auth': { subject: 'Hello\r\nBcc: someone@example.test' } });
    await expect(renderEmail({ gymName: 'Gym', t: malicious, subjectKey: 'staff/auth:subject', footerKey: 'staff/auth:footer' }))
      .rejects.toThrow('Invalid email subject');
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { demoLandingPage } from '../../demo/landing.page.js';
import { buildLabel, buildLabelItem } from './build-label.js';

describe('buildLabel', () => {
  it('links a plain release to its page on the source repository', () => {
    expect(buildLabel('0.5.0', 'https://github.com/plaingym/plaingym')).toEqual({
      text: 'v0.5.0', label: 'Version v0.5.0', href: 'https://github.com/plaingym/plaingym/releases/tag/v0.5.0',
    });
  });
  it('links a fork to its own releases, whatever tag the source URL names', () => {
    expect(buildLabel('0.5.0', 'https://git.example.org/acme/gym/tree/v0.5.0?x=1').href).toBe('https://git.example.org/acme/gym/releases/tag/v0.5.0');
  });
  it.each(['0.4.0+0.g6e55ffe', '0.5.0-rc.1', 'dev'])('shows %s as it is, without a link', (version) => {
    expect(buildLabel(version, 'https://github.com/plaingym/plaingym')).toEqual({ text: version, label: 'Version ' + version });
  });
  it('renders a link for a release and a labelled note otherwise', () => {
    expect(String(buildLabelItem('c', buildLabel('0.5.0', 'https://github.com/a/b')))).toBe(
      '<a href="https://github.com/a/b/releases/tag/v0.5.0" rel="noreferrer" class="c min-w-11 justify-center underline" aria-label="Version v0.5.0">v0.5.0</a>');
    expect(String(buildLabelItem('c', buildLabel('0.4.0+1', 'https://github.com/a/b')))).toBe(
      '<span role="note" class="c" aria-label="Version 0.4.0+1">0.4.0+1</span>');
  });
  it('links the label in the product page footer through the source redirect for a non-GitHub repository', () => {
    process.env.APP_VERSION = '0.5.0';
    try {
      const html = demoLandingPage('https://showcase.example.test/demo', 'https://git.example.org/acme/gym');
      expect(html).toMatch(/<a href="\/source"[^>]+aria-label="Version v0\.5\.0">v0\.5\.0<\/a>/);
    } finally { delete process.env.APP_VERSION; }
  });
});

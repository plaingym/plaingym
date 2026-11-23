// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { demoLandingPage } from '../../demo/landing.page.js';
import { buildLabel, buildLabelItem } from './build-label.js';

describe('buildLabel', () => {
  it('links a plain release to its page on the source repository', () => {
    expect(buildLabel('0.5.0', 'https://github.com/plaingym/plaingym')).toEqual({
      text: 'v0.5.0', label: 'Version v0.5.0', prefix: 'Version', href: 'https://github.com/plaingym/plaingym/releases/tag/v0.5.0',
    });
  });
  it('links a fork to its own releases, whatever tag the source URL names', () => {
    expect(buildLabel('0.5.0', 'https://git.example.org/acme/gym/tree/v0.5.0?x=1').href).toBe('https://git.example.org/acme/gym/releases/tag/v0.5.0');
  });
  it('leaves the release unlinked for a nested repository', () => {
    expect(buildLabel('0.5.0', 'https://gitlab.com/group/sub/gym')).toEqual({ text: 'v0.5.0', label: 'Version v0.5.0', prefix: 'Version' });
  });
  it('uses the supplied translator for both names', () => {
    const t = createTranslator({ 'shell/shell': { version: 'Versión {version}', versionPrefix: 'Versión' } });
    expect(buildLabel('0.5.0', 'https://github.com/a/b', t)).toMatchObject({ label: 'Versión v0.5.0', prefix: 'Versión' });
  });
  it.each(['0.4.0+0.g6e55ffe', '0.5.0-rc.1', 'dev'])('shows %s as it is, without a link', (version) => {
    expect(buildLabel(version, 'https://github.com/plaingym/plaingym')).toEqual({ text: version, label: 'Version ' + version, prefix: 'Version' });
  });
  it('renders a visually hidden prefix before the visible version', () => {
    expect(String(buildLabelItem('c', buildLabel('0.5.0', 'https://github.com/a/b')))).toBe(
      '<a href="https://github.com/a/b/releases/tag/v0.5.0" rel="noreferrer" class="c min-w-11 justify-center underline"><span class="sr-only">Version </span>v0.5.0</a>');
    expect(String(buildLabelItem('c', buildLabel('0.4.0+1', 'https://github.com/a/b')))).toBe(
      '<span class="c"><span class="sr-only">Version </span>0.4.0+1</span>');
  });
  it('shows the full label on a page without a stylesheet', () => {
    const options = { visibleName: true };
    expect(String(buildLabelItem('c', buildLabel('0.5.0', 'https://github.com/a/b'), options))).toBe(
      '<a href="https://github.com/a/b/releases/tag/v0.5.0" rel="noreferrer" class="c min-w-11 justify-center underline">Version v0.5.0</a>');
    expect(String(buildLabelItem('c', buildLabel('0.4.0+1', 'https://github.com/a/b'), options))).toBe(
      '<span class="c">Version 0.4.0+1</span>');
  });
  it('links the label in the product page footer through the source redirect for a non-GitHub repository', () => {
    process.env.APP_VERSION = '0.5.0';
    try {
      const html = demoLandingPage('https://showcase.example.test/demo', 'https://git.example.org/acme/gym');
      expect(html).toMatch(/<a href="\/source"[^>]*><span class="sr-only">Version <\/span>v0\.5\.0<\/a>/);
    } finally { delete process.env.APP_VERSION; }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { siteThemeCss, siteThemeVersion } from './site.page.js';

describe('website theme colors', () => {
  it('ignores legacy accents in both the stylesheet and its cache version', () => {
    for (const accent of [null, '#112233', '#ffffff']) {
      expect(siteThemeCss('#ffcc00', accent)).toBe(siteThemeCss('#ffcc00', null));
      expect(siteThemeVersion('#ffcc00', accent)).toBe(siteThemeVersion('#ffcc00', null));
    }
    expect(siteThemeCss('#ffcc00', '#112233')).toContain('--color-secondary:#fffae6');
    expect(siteThemeCss(null, '#112233')).toBe('');
  });
  it('chooses contrasting text and rejects invalid primary colors', () => {
    expect(siteThemeCss('#000000', null)).toContain('--color-primary-foreground:#ffffff');
    expect(siteThemeCss('#000000', null)).toContain('--color-secondary:#e6e6e6;--color-secondary-foreground:#000000');
    expect(siteThemeCss('red;display:none', '#112233')).toBe('');
  });
});

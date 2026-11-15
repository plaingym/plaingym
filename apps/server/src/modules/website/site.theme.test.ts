// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { siteThemeCss, siteThemeVersion } from './site.page.js';

describe('website theme colors', () => {
  it('derives the stylesheet and its cache version from the primary color', () => {
    expect(siteThemeVersion('#ffcc00')).not.toBe(siteThemeVersion('#000000'));
    expect(siteThemeCss('#ffcc00')).toContain('--color-secondary:#fffae6');
    expect(siteThemeCss(null)).toBe('');
  });
  it('chooses contrasting text and rejects invalid primary colors', () => {
    expect(siteThemeCss('#000000')).toContain('--color-primary-foreground:#ffffff');
    expect(siteThemeCss('#000000')).toContain('--color-secondary:#e6e6e6;--color-secondary-foreground:#000000');
    expect(siteThemeCss('red;display:none')).toBe('');
  });
});

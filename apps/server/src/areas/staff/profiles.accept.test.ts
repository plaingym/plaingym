// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { invitationPage } from './profiles.accept.js';

describe('staff invitation footer version label', () => {
  it('uses the page translator for the footer version prefix and keeps English by default', () => {
    const english = invitationPage(createTranslator(locales.en ?? {}), true, 'nonce').toString();
    expect(english).toContain('<span class="sr-only">Version </span>');
    const probe = createTranslator({ ...locales.en, 'shell/shell': { ...locales.en?.['shell/shell'], versionPrefix: 'Probe' } });
    expect(invitationPage(probe, true, 'nonce').toString()).toContain('<span class="sr-only">Probe </span>');
  });
});

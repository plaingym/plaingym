// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SettingsSection } from '../../lib/registries.js';
import { orderSettingsSections, SettingsSectionMenu } from './section-menu.js';
afterEach(cleanup);
const entry = (id: string, labelKey: string, listed?: () => boolean): SettingsSection => ({ id, labelKey, ...(listed ? { listed } : {}),
  permission: { kind: 'staff', capability: 'settings.manage' }, enabled: true, component: () => null });
describe('settings section navigation', () => {
  it('opens with Gym details and puts go-live after integrations and billing', () => {
    const general = entry('settingsSections.settings.general', 'settings/settings:general');
    const billing = entry('settingsSections.settings.billing', 'settings/billing:title');
    const live = entry('settingsSections.settings.go-live', 'settings/go-live:title');
    expect(orderSettingsSections([live, billing, general])).toEqual([general, billing, live]);
  });
  it('links to permitted sections and respects each section availability hook', () => {
    render(<SettingsSectionMenu sections={[entry('gym', 'settings/settings:general'), entry('off', 'settings/auth:title', () => false)]}/>);
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Gym details' }).getAttribute('href')).toBe('#gym');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});

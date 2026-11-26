// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SettingsSection } from '../../lib/registries.js';
import { SettingsPage } from '../../routes/admin/settings/index.js';
import { orderSettingsSections, SettingsSectionMenu } from './section-menu.js';
// The page around the menu, with one section of its own.
vi.mock('../../app/context.js', () => ({
  useBootstrap: () => ({ isPending: false, isError: false, data: { gym: { enabledModules: [] }, session: { roles: ['owner'] } } }),
}));
vi.mock('../../lib/registries.js', () => ({ createRegistries: () => ({ settingsSections: { forModules: () => [
  { id: 'gym', labelKey: 'settings/settings:general', enabled: true, permission: { kind: 'staff', capability: 'settings.manage' }, component: () => null }] } }) }));
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
    // The page's scroll padding alone keeps a focused link below the header.
    expect(screen.getByRole('link', { name: 'Gym details' }).className).not.toContain('scroll-mt');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
  it('leaves a section only its gap below the page scroll padding', () => {
    render(<SettingsPage/>);
    expect(screen.getByRole('region', { name: 'Gym details' }).classList).toContain('scroll-mt-2');
  });
});

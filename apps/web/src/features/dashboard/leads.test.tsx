// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DashboardWidget } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import { DashboardWidgets } from './widgets.js';
import { leadsWidgetViews } from './leads.widgets.js';

afterEach(cleanup);
const id = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const tile = (count: number, items: { label: string; href: string }[]): DashboardWidget => ({
  id: 'leads.follow-ups-due', titleKey: 'leads/screens:tile.title', status: 'ready', kind: 'count', count, items });
const mount = (widget: DashboardWidget, roles: readonly StaffRole[] = ['front_desk']) =>
  render(<DashboardWidgets widgets={[widget]} roles={roles} views={leadsWidgetViews} />);

describe('follow-ups due tile', () => {
  it('shows the count, each due lead linking to its lead page, how many are shown and a link to the list', () => {
    mount(tile(21, [{ label: 'Ada Alpha', href: '/admin/leads/' + id(1) }, { label: 'Ben Beta', href: '/admin/leads/' + id(2) }]));
    const card = screen.getByRole('region', { name: 'Follow-ups due' });
    expect(within(card).getByText('21')).toBeDefined();
    expect(within(card).getByRole('link', { name: 'Ada Alpha' }).getAttribute('href')).toBe('/admin/leads/' + id(1));
    expect(within(card).getByText('Showing 2 of 21')).toBeDefined();
    expect(within(card).getByRole('link', { name: 'Open the leads list' }).getAttribute('href')).toBe('/admin/leads');
  });
  it.each(['owner', 'admin', 'front_desk'] as const)('shows for %s', role => {
    mount(tile(1, [{ label: 'Ada Alpha', href: '/admin/leads/' + id(1) }]), [role]);
    expect(screen.getByRole('region', { name: 'Follow-ups due' })).toBeDefined();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
  it('is hidden from a coach, and when nothing is due', () => {
    mount(tile(1, [{ label: 'Ada Alpha', href: '/admin/leads/' + id(1) }]), ['coach']);
    expect(screen.queryByRole('region', { name: 'Follow-ups due' })).toBeNull();
    cleanup();
    mount(tile(0, []));
    expect(screen.queryByRole('region', { name: 'Follow-ups due' })).toBeNull();
  });
});

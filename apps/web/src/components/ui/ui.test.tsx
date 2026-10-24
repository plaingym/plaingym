// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from './button.js';
import { Page, PageHeader, PageSection } from './page.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { CheckboxField, Select } from './select.js';
import { Badge, TableContainer } from './table.js';
afterEach(cleanup);
describe('shared page components', () => {
  it('renders one page heading with its actions', () => {
    render(<Page><PageHeader title="Members" description="Everyone at the gym" actions={<Button>Add member</Button>} />
      <PageSection title="Recent"><p>Body</p></PageSection></Page>);
    expect(screen.getByRole('heading', { level: 1, name: 'Members' })).toBeDefined();
    expect(screen.getByRole('heading', { level: 2, name: 'Recent' })).toBeDefined();
    expect(screen.getByText('Everyone at the gym')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeDefined();
  });
  it('announces loading and errors and offers a retry', () => {
    const retry = vi.fn();
    render(<><LoadingState /><ErrorState message="Check your connection." onRetry={retry} /></>);
    expect(screen.getByRole('status').textContent).toContain('Loading...');
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain('Check your connection.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
  it('omits the retry button when there is nothing to retry', () => {
    render(<ErrorState />);
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('shows an empty state with its next step', () => {
    render(<EmptyState title="No members yet" description="Add one or import a CSV." action={<Button>Add member</Button>} />);
    expect(screen.getByText('No members yet')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeDefined();
  });
  it('keeps every button size at a 44 px touch target and defaults to type=button', () => {
    render(<><Button size="sm">Small</Button><Button size="icon" aria-label="Close">x</Button><Button variant="destructive">Delete</Button></>);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('min-h-11');
      expect(button.getAttribute('type')).toBe('button');
    }
  });
  it('makes wide tables a focusable, labelled scroll region', () => {
    render(<TableContainer label="Members table"><table><tbody><tr><td>Row</td></tr></tbody></table></TableContainer>);
    const region = screen.getByRole('region', { name: 'Members table' });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.className).toContain('overflow-x-auto');
  });
  it('labels form controls and badges', () => {
    render(<><label htmlFor="status">Status</label><Select id="status"><option>Active</option></Select>
      <CheckboxField label="Active only" defaultChecked /><Badge tone="success">Active</Badge></>);
    expect(screen.getByLabelText('Status').tagName).toBe('SELECT');
    expect((screen.getByLabelText('Active only') as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByText('Active').length).toBe(2);
  });
});

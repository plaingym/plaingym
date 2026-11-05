// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Button } from './button.js';
import { Page, PageHeader, PageSection } from './page.js';
import { EmptyState, ErrorState, LoadingState } from './states.js';
import { CheckboxField, Select } from './select.js';
import { Badge, TableContainer } from './table.js';
import { breaksAnywhere } from './wrap.test-helper.js';
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
  it('lets titles and anything inside a page wrap a name with no break opportunity', () => {
    const long = 'U'.padEnd(56, 'x');
    render(<Page><PageHeader title={long + 'h'} /><PageSection title={long + 's'}><p>{long}</p></PageSection></Page>);
    for (const text of [long + 'h', long + 's', long]) expect(breaksAnywhere(screen.getByText(text))).toBe(true);
    // The check fails for a class that does nothing, and for a nearer element that turns wrapping off.
    render(<p className="min-w-0 break-normal">{'plain'}</p>);
    expect(breaksAnywhere(screen.getByText('plain'))).toBe(false);
    render(<Page><p className="wrap-normal">{'reset'}</p></Page>);
    expect(breaksAnywhere(screen.getByText('reset'))).toBe(false);
  });
  it('decides by the generated rule order, not the class order, and honors rules from ancestors', () => {
    // `wrap-normal` is emitted after `wrap-anywhere`, so it wins whichever order the classes are written in.
    render(<><p className="wrap-anywhere wrap-normal">{'one'}</p><p className="wrap-normal wrap-anywhere">{'two'}</p></>);
    expect(breaksAnywhere(screen.getByText('one'))).toBe(false);
    expect(breaksAnywhere(screen.getByText('two'))).toBe(false);
    // A descendant rule on an ancestor (`[&_table]:wrap-normal`) reaches the cell, and beats the cell's own inherited value.
    render(<Page><table><tbody><tr><td>{'cell'}</td></tr></tbody></table><TableContainer label="Scroller"><table><tbody><tr><td>{'boxed'}</td></tr></tbody></table></TableContainer></Page>);
    expect(breaksAnywhere(screen.getByText('cell'))).toBe(false);
    expect(breaksAnywhere(screen.getByText('boxed'))).toBe(false);
    // A rule that sits behind a variant doesn't apply to a resting element.
    render(<p className="hover:wrap-anywhere">{'hover'}</p>);
    expect(breaksAnywhere(screen.getByText('hover'))).toBe(false);
  });
  it('scores pseudo-class wrappers by what a browser counts', () => {
    // `:first-child` (0,2,0) beats `:where(:is(ul)) .in-[ul]` (0,1,0), though the latter is emitted later.
    render(<ul><li className="first:wrap-anywhere in-[ul]:wrap-normal">{'first'}</li></ul>);
    expect(breaksAnywhere(screen.getByText('first'))).toBe(true);
    // `:has(:is(p))` adds a type (0,1,1), so `:first-child` (0,2,0) still wins.
    render(<div><div className="first:wrap-normal has-[p]:wrap-anywhere"><p>{'has'}</p></div></div>);
    expect(breaksAnywhere(screen.getByText('has'))).toBe(false);
  });
  it('keeps app labels whole beside a long name, and lets a button that carries a name wrap it', () => {
    const long = 'U'.padEnd(56, 'x');
    render(<Page><PageSection title="Programs"><ul><li><span>{long}</span><Badge tone="success">Active</Badge><Button>Save</Button>
      <Button className="wrap-anywhere">{'Edit ' + long}</Button></li></ul></PageSection></Page>);
    expect(breaksAnywhere(screen.getByText(long))).toBe(true);
    expect(breaksAnywhere(screen.getByText('Active'))).toBe(false);
    expect(screen.getByText('Active').className).toContain('shrink-0');
    expect(breaksAnywhere(screen.getByRole('button', { name: 'Save' }))).toBe(false);
    expect(breaksAnywhere(screen.getByRole('button', { name: 'Edit ' + long }))).toBe(true);
  });
  it('wraps titles used outside a page', () => {
    const long = 'U'.padEnd(56, 'x');
    render(<><PageHeader title={long + 'a'} /><PageSection title={long + 'b'}><p>body</p></PageSection></>);
    expect(breaksAnywhere(screen.getByText(long + 'a'))).toBe(true);
    expect(breaksAnywhere(screen.getByText(long + 'b'))).toBe(true);
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

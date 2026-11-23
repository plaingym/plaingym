// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Autocomplete } from './autocomplete.js';
import { Page } from './page.js';
import { breaksAnywhere } from './wrap.test-helper.js';
afterEach(cleanup);
it('lets an option name with no break opportunity wrap instead of widening its list', async () => {
  const user = userEvent.setup(), long = 'U'.padEnd(56, 'x');
  render(<Page><Autocomplete label="Household" query="" value="" onQueryChange={() => undefined} onChange={() => undefined} options={[{ id: '1', label: long }]} /></Page>);
  await user.click(screen.getByRole('combobox'));
  expect(breaksAnywhere(screen.getByRole('option', { name: long }))).toBe(true);
});
const options = [{ id: '1', label: 'Rivera household' }, { id: '2', label: 'Smith household' }];
function Example({ selected = vi.fn(), submit = vi.fn() }) {
  const [query, setQuery] = useState(''), [value, setValue] = useState('');
  return <form onSubmit={e => { e.preventDefault(); submit(value); }}><Autocomplete label="Household" query={query} value={value}
    onQueryChange={setQuery} onChange={id => { setValue(id); selected(id); }} options={options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))} required /><button>Save</button></form>;
}
it('filters and selects in one input, supports keyboard selection without submitting, and clears stale selection', async () => {
  const user = userEvent.setup(), selected = vi.fn(), submit = vi.fn(); render(<Example selected={selected} submit={submit} />);
  const combo = screen.getByRole('combobox'); await user.type(combo, 'riv');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(combo.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option').id);
  await user.keyboard('{Enter}'); expect(selected).toHaveBeenLastCalledWith('1'); expect(submit).not.toHaveBeenCalled();
  expect((combo as HTMLInputElement).value).toBe('Rivera household'); expect(combo.getAttribute('aria-expanded')).toBe('false');
  await user.click(screen.getByRole('button', { name: 'Save' })); expect(submit).toHaveBeenCalledWith('1');
  await user.clear(combo); await user.type(combo, 'missing'); expect(selected).toHaveBeenLastCalledWith('');
  expect(screen.getByRole('status').textContent).toContain('No matching households');
  expect((combo as HTMLInputElement).checkValidity()).toBe(false);
});
it('supports pointer selection, arrows, Escape and blur without trapping focus', async () => {
  const user = userEvent.setup(), selected = vi.fn(); render(<Example selected={selected} />);
  const combo = screen.getByRole('combobox'); await user.click(combo); await user.keyboard('{End}{Enter}');
  expect(selected).toHaveBeenLastCalledWith('2');
  await user.clear(combo); await user.keyboard('{ArrowDown}{ArrowUp}{Escape}'); expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.focus(combo); await user.click(screen.getByRole('option', { name: 'Rivera household' })); expect(selected).toHaveBeenLastCalledWith('1');
  await user.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Save' }));
});
it('shows the default empty text, or the emptyLabel a caller passes', async () => {
  const user = userEvent.setup();
  const props = { label: 'Household', query: '', value: '', onQueryChange: () => undefined, onChange: () => undefined, options: [] as { id: string; label: string }[] };
  const view = render(<Autocomplete {...props} />);
  await user.click(screen.getByRole('combobox'));
  expect(screen.getByRole('status').textContent).toBe('No matching households. Try another name.');
  view.rerender(<Autocomplete {...props} emptyLabel="Nothing here" />);
  expect(screen.getByRole('status').textContent).toBe('Nothing here');
});
it('hides the empty popup when emptyLabel is null but keeps options, the help text and arrow keys', async () => {
  const user = userEvent.setup();
  const props = { label: 'Member', query: '', value: '', onQueryChange: () => undefined, onChange: () => undefined };
  const view = render(<Autocomplete {...props} options={[]} emptyLabel={null} />);
  const combo = screen.getByRole('combobox');
  await user.click(combo);
  expect(combo.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  view.rerender(<Autocomplete {...props} options={options} emptyLabel={null} />);
  expect(combo.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(screen.getByRole('status').textContent).toBe('Use the arrow keys and Enter to select.');
  await user.keyboard('{ArrowDown}');
  expect(combo.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Smith household' }).id);
});
it('stays closed and ignores edits while disabled', () => {
  const query = vi.fn(), change = vi.fn();
  render(<Autocomplete label="Member" query="" value="" disabled onQueryChange={query} onChange={change} options={options} />);
  const combo = screen.getByRole('combobox');
  expect((combo as HTMLInputElement).disabled).toBe(true);
  fireEvent.focus(combo); fireEvent.change(combo, { target: { value: 'riv' } });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(query).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
});

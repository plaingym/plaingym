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

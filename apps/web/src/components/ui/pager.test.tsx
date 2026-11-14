// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pager } from './pager.js';

afterEach(cleanup);
it.each([0, 1, 20])('hides controls for a one-page list of %s rows', total => {
  render(<Pager offset={0} total={total} onChange={vi.fn()}/>);
  expect(screen.queryByRole('button')).toBeNull();
});
it('clamps Previous and allows recovery after the total shrinks', () => {
  const change = vi.fn();
  render(<Pager offset={5} total={0} limit={20} onChange={change}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(change).toHaveBeenCalledWith(0);
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});
it('uses the supplied page size and blocks both controls during an operation', () => {
  const change = vi.fn();
  const { rerender } = render(<Pager offset={0} total={51} limit={50} onChange={change}/>);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(change).toHaveBeenCalledWith(50);
  rerender(<Pager offset={50} total={51} limit={50} onChange={change} disabled/>);
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true);
});

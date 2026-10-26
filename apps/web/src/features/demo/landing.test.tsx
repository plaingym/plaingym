// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DemoPage } from './landing.js';

const context = vi.hoisted(() => ({ mode: undefined as 'disabled' | 'entry' | 'sandbox' | undefined }));
vi.mock('./notice.js', () => ({ useDemoMode: () => context.mode }));
afterEach(cleanup);

it('shows role cards in entry mode without repeating the root entry title or help', () => {
  context.mode = 'entry';
  render(<DemoPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Explore by role' })).toBeDefined();
  for (const name of ['Owner', 'Coach', 'Student']) expect(screen.getByRole('heading', { name })).toBeDefined();
  expect(screen.queryByText('Explore PlainGym')).toBeNull();
  expect(screen.queryByText(/Start your own sample gym/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
});
it.each(['disabled', 'sandbox', undefined] as const)('shows a neutral sign-in route in %s mode', (mode) => {
  context.mode = mode;
  render(<DemoPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'PlainGym demo' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/login');
  expect(screen.queryByRole('heading', { name: 'Owner' })).toBeNull();
  expect(screen.queryByText(/Start your own sample gym/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
});

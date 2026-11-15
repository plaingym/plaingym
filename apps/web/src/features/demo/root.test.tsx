// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({ mode: undefined as string | undefined }));
vi.mock('./notice.js', async original => ({ ...await original<typeof import('./notice.js')>(), useDemoMode: () => state.mode }));
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => () => ({}), Navigate: ({ to }: { to: string }) => <p>Redirect: {to}</p> }));
import { HomePage } from '../../routes/index.js';
afterEach(cleanup);
it('keeps the SPA fallback neutral after the server takes over the entry landing', () => {
  const view = render(<HomePage />); expect(screen.getByRole('status')).toBeDefined();
  state.mode = 'entry'; view.rerender(<HomePage />);
  expect(screen.getByRole('heading', { name: 'PlainGym demo' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/login');
  expect(screen.queryByText('Explore by role')).toBeNull();
});
it.each(['sandbox', 'disabled'])('sends %s roots to the existing sign-in flow', mode => {
  state.mode = mode; render(<HomePage />); expect(screen.getByText('Redirect: /login')).toBeDefined();
});

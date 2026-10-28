// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const state = vi.hoisted(() => ({ mode: undefined as string | undefined }));
vi.mock('./notice.js', () => ({ useDemoMode: () => state.mode }));
vi.mock('@tanstack/react-router', () => ({ createFileRoute: () => () => ({}), Navigate: ({ to }: { to: string }) => <p>Redirect: {to}</p> }));
import { HomePage } from '../../routes/index.js';
afterEach(cleanup);
it('waits for discovery before rendering the entry landing', () => {
  const view = render(<HomePage />); expect(screen.getByRole('status')).toBeDefined();
  state.mode = 'entry'; view.rerender(<HomePage />);
  expect(screen.getByRole('heading', { name: 'Explore by role' })).toBeDefined(); expect(screen.queryByText('Page not found')).toBeNull();
});
it.each(['sandbox', 'disabled'])('sends %s roots to the existing sign-in flow', mode => {
  state.mode = mode; render(<HomePage />); expect(screen.getByText('Redirect: /login')).toBeDefined();
});

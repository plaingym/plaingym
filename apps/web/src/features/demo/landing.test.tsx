// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DemoPage } from './landing.js';

const context = vi.hoisted(() => ({ mode: undefined as 'disabled' | 'entry' | 'sandbox' | undefined, join: true, login: vi.fn(), pending: false, error: false }));
vi.mock('./notice.js', () => ({ useDemoMode: () => context.mode, useDemoJoin: () => context.join,
  useDemoLogin: () => ({ login: context.login, pending: context.pending, error: context.error }) }));
afterEach(() => { cleanup(); context.join = true; context.login.mockReset(); context.pending = false; context.error = false; });

it('shows role cards in entry mode without repeating the root entry title or help', () => {
  context.mode = 'entry';
  render(<DemoPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Explore by role' })).toBeDefined();
  for (const name of ['Owner', 'Coach', 'Student']) expect(screen.getByRole('heading', { name })).toBeDefined();
  expect(screen.queryByText('Explore PlainGym')).toBeNull();
  expect(screen.queryByText(/Start your own sample gym/)).toBeNull();
  expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
});
it.each(['disabled', undefined] as const)('shows a neutral sign-in route in %s mode', (mode) => {
  context.mode = mode;
  render(<DemoPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'PlainGym demo' })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/login');
  expect(screen.queryByRole('heading', { name: 'Owner' })).toBeNull();
  expect(screen.queryByText(/Start your own sample gym/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try the demo' })).toBeNull();
});
it('starts a sandbox with one-click roles, the test-card join walkthrough and the kiosk', () => {
  context.mode = 'sandbox';
  render(<DemoPage />);
  expect(screen.getByRole('heading', { level: 1, name: 'Your demo gym' })).toBeDefined();
  for (const role of ['owner', 'coach', 'student']) fireEvent.click(screen.getByRole('button', { name: `Sign in as ${role}` }));
  expect(context.login.mock.calls).toEqual([['owner'], ['coach'], ['student']]);
  expect(screen.getByText(/Alex Student: two booked classes, a waitlist place/)).toBeDefined();
  expect(screen.queryByText(/no test payments/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the join page' }).getAttribute('href')).toBe('/join');
  expect(screen.getByText('4242 4242 4242 4242')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Open the demo outbox' }));
  expect(context.login).toHaveBeenLastCalledWith('owner', '/admin/outbox');
  expect(screen.getByRole('link', { name: 'Open the kiosk' }).getAttribute('href')).toBe('/kiosk');
  expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
});
it('replaces the join steps with a one-line note when the demo has no test payments, keeping roles and kiosk', () => {
  context.mode = 'sandbox'; context.join = false;
  render(<DemoPage />);
  expect(screen.getByText("This demo has no test payments, so joining online isn't available.")).toBeDefined();
  expect(screen.queryByRole('link', { name: 'Open the join page' })).toBeNull();
  expect(screen.queryByText('4242 4242 4242 4242')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open the demo outbox' })).toBeNull();
  for (const role of ['owner', 'coach', 'student']) expect(screen.getByRole('button', { name: `Sign in as ${role}` })).toBeDefined();
  expect(screen.getByRole('link', { name: 'Open the kiosk' }).getAttribute('href')).toBe('/kiosk');
});
it('disables the sandbox sign-ins while one is pending, leaving failures to the banner', () => {
  context.mode = 'sandbox'; context.pending = true; context.error = true;
  render(<DemoPage />);
  expect(screen.queryByRole('alert')).toBeNull();
  for (const name of ['Sign in as owner', 'Sign in as coach', 'Sign in as student', 'Open the demo outbox'])
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
});

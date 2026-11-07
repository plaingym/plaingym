// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DemoPage } from './landing.js';

const context = vi.hoisted(() => ({ mode: undefined as 'disabled' | 'entry' | 'sandbox' | undefined, join: true, login: vi.fn(), pending: false, error: false,
  members: [] as { id: string; name: string }[] }));
vi.mock('./notice.js', async (original) => ({ ...await original<typeof import('./notice.js')>(), useDemoMode: () => context.mode, useDemoJoin: () => context.join,
  useDemoLogin: () => ({ login: context.login, pending: context.pending, error: context.error }), useDemoMenu: () => ({ data: { members: context.members, website: false } }) }));
afterEach(() => { cleanup(); context.join = true; context.login.mockReset(); context.pending = false; context.error = false; context.members = []; });

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
  expect(screen.getByText(/check-in QR code and paid invoices/)).toBeDefined();
  expect(screen.queryByText(/when this demo has/)).toBeNull();
  expect(screen.queryByText(/no test payments/)).toBeNull();
  expect(screen.getByRole('link', { name: 'Open the join page' }).getAttribute('href')).toBe('/join');
  expect(screen.getByText('4242 4242 4242 4242')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Open the demo outbox' }));
  expect(context.login).toHaveBeenLastCalledWith('owner', '/admin/outbox');
  expect(screen.getByRole('link', { name: 'Open the kiosk' }).getAttribute('href')).toBe('/kiosk');
  expect(screen.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
  // The kiosk's sample household is shown on the kiosk's own search, not here; nobody has joined yet.
  expect(document.body.textContent).not.toMatch(/Marcus Rivera|2468/);
  expect(screen.queryByRole('heading', { name: 'Members who joined' })).toBeNull();
});
it('offers the members who joined by name, as sign-in buttons', () => {
  context.mode = 'sandbox';
  context.members = [{ id: '019a0000-0000-7000-8000-0000000000aa', name: 'Riley Visitor' }, { id: '019a0000-0000-7000-8000-0000000000ab', name: 'Sam Joiner' }];
  render(<DemoPage />);
  expect(screen.getByRole('heading', { name: 'Members who joined' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in as Sam Joiner' }));
  expect(context.login).toHaveBeenLastCalledWith({ member: '019a0000-0000-7000-8000-0000000000ab' });
  expect(screen.getByRole('button', { name: 'Sign in as Riley Visitor' })).toBeDefined();
});
it('uses one control style: navigation is a full-width menu link, signing in is a button', () => {
  context.mode = 'sandbox';
  render(<DemoPage />);
  for (const link of screen.getAllByRole('link')) {
    expect(link.className).toContain('w-full');
    expect(link.className).not.toContain('underline');
  }
  for (const name of ['Sign in as owner', 'Open the demo outbox']) expect(screen.getByRole('button', { name }).className).toContain('w-full');
});
it('replaces the join steps and student billing copy when joining is unavailable, keeping roles and kiosk', () => {
  context.mode = 'sandbox'; context.join = false;
  render(<DemoPage />);
  expect(screen.getByText("Joining online isn't available in this demo gym right now.")).toBeDefined();
  expect(screen.queryByText(/paid invoices/)).toBeNull();
  expect(screen.queryByText(/join as a new member with a test card/)).toBeNull();
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

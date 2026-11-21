// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CopyPrompt, CreateCopyButton, rememberDemoRole } from './copy.js';
import { ApiError, createJsonTransport } from '../../lib/api.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); });
const result = { data: { gymId: '019a0000-0000-7000-8000-000000000001', origin: 'https://copy.demo.example.test',
  expiresAt: '2099-11-14T12:00:00Z', kioskToken: 'kiosk', handoffToken: 'a'.repeat(43) } };
const bootstrap = () => Response.json({ data: { gym: { id: result.data.gymId, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
  session: { userId: result.data.gymId, displayName: 'Alex Student', roles: [], member: true }, login: { password: false, magicLink: true } } });
it('opens only for a showcase API refusal and leaves global fetch intact after mounting and unmounting', async () => {
  const original = window.fetch;
  const { unmount } = render(<CopyPrompt showcase />);
  expect(window.fetch).toBe(original);
  const refuse = (reason: string) => createJsonTransport(async () => Response.json({ error: { details: { reason: [reason] } } }, { status: 403 }))('/api/demo/login', {}).catch(() => {});
  await act(async () => { new ApiError(403, 'forbidden', ['demo_showcase_read_only']); });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { await refuse('another_reason'); });
  expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => { await refuse('demo_showcase_read_only'); });
  expect(screen.getByRole('dialog')).toBeDefined();
  unmount(); expect(window.fetch).toBe(original);
});
it('creates only once and hands off the selected role and static page to the destination host', async () => {
  window.history.replaceState(null, '', '/portal'); rememberDemoRole('owner');
  let complete!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(async input => input === '/api/auth/bootstrap' ? bootstrap() : new Promise<Response>(resolve => { complete = resolve; })); vi.stubGlobal('fetch', fetcher);
  const navigate = vi.fn(); render(<CreateCopyButton navigate={navigate} />);
  const button = screen.getByRole('button'); fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ role: 'student', page: '/portal' });
  await act(async () => { complete(Response.json(result)); });
  expect(navigate).toHaveBeenCalledWith('https://copy.demo.example.test/demo#copyToken=' + 'a'.repeat(43));
});
it('shows the bounded queue position and polls without creating a second request', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(Response.json({ data: { pending: true, ticket: 'b'.repeat(43), position: 3, retryAfterSeconds: 2 } }))
    .mockResolvedValueOnce(Response.json(result)); vi.stubGlobal('fetch', fetcher);
  const navigate = vi.fn(); render(<CreateCopyButton navigate={navigate} />);
  fireEvent.click(screen.getByRole('button'));
  await screen.findByText(/Your place in line: 3/);
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce(), { timeout: 4000 });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2]![0]).toBe('/api/demo/creations/' + 'b'.repeat(43));
});
it.each([
  [429, '2400', "You've reached the hourly limit on new demo copies from this network. Please try again in 40 min."],
  [429, '30', "You've reached the hourly limit on new demo copies from this network. Please try again in 1 min."],
  [429, undefined, 'Demo capacity is temporarily full. Please try again later.'],
  [429, '30.5', 'Demo capacity is temporarily full. Please try again later.'],
  [500, undefined, 'We could not create your demo gym. Retry below. If this continues, the demo operator needs to check payment and storage access.'],
] as const)('explains HTTP %s with Retry-After %s and re-enables the copy button', async (status, retryAfter, message) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(Response.json({}, {
    status, ...(retryAfter === undefined ? {} : { headers: { 'Retry-After': retryAfter } }),
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<CreateCopyButton />);
  const button = screen.getByRole('button') as HTMLButtonElement;
  fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toBe(message);
  expect(button.disabled).toBe(false);
  const creations = fetcher.mock.calls.filter(([path]) => path === '/api/demo/sandboxes');
  expect(creations.map(([, init]) => init?.method)).toEqual(['POST']);
});

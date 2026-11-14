// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateCopyButton, rememberDemoRole } from './copy.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); sessionStorage.clear(); });
const result = { data: { gymId: '019a0000-0000-7000-8000-000000000001', origin: 'https://copy.demo.example.test',
  expiresAt: '2099-11-14T12:00:00Z', kioskToken: 'kiosk', handoffToken: 'a'.repeat(43) } };
const bootstrap = () => Response.json({ data: { gym: { id: result.data.gymId, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
  session: { userId: result.data.gymId, displayName: 'Alex Student', roles: [], member: true }, login: { password: false, magicLink: true } } });
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

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { ShellServicesContext } from '../../app/context.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupControl } from '@plaingym/shared/contracts';
import { BackupActions } from './backups.js';
import { api } from '../../lib/api.js';
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn(), POST: vi.fn() } }));
const uuid = (n: number) => `0198a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-11-12T12:00:00.000Z';
let state: BackupControl;
const ok = (data: unknown) => ({ response: new Response(), data }) as never;
const GET = vi.mocked(api.GET) as unknown as ReturnType<typeof vi.fn>, POST = vi.mocked(api.POST) as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  state = { available: true, configured: true, pruningHeld: true, revision: 4, manual: null };
  GET.mockImplementation(async () => ok({ data: state }));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function start(owner = true, onConfirmed = vi.fn()) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={cache}><ShellServicesContext.Provider value={({ signInWithPassword: async () => {}, requestMagicLink: async () => {}, signOut: async () => {}, loadBootstrap: async () => ({ gym: { id: 'gym', name: 'Gym', timezone: 'America/Los_Angeles', currency: 'USD', enabledModules: [] }, session: null, login: { password: true, magicLink: false } }) })}><BackupActions gymId={uuid(1)} owner={owner} onConfirmed={onConfirmed}/></ShellServicesContext.Provider></QueryClientProvider>);
  return { cache, onConfirmed };
}
describe('backup actions shared by Settings and Health', () => {
  it.each([200, 409, 500])('retains an uncertain request only until a definite HTTP answer (%s)', async status => {
    POST.mockImplementationOnce(async () => ({ response: new Response(null, { status }), data: {} }));
    POST.mockImplementationOnce(async (_path: string, input: { body: { requestId: string } }) => {
      state = { ...state, manual: { requestId: input.body.requestId, status: 'queued', requestedAt: now, completedAt: null, snapshotId: null, failure: null } };
      return ok({ data: state });
    });
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    await screen.findByText(/Unable to confirm the backup request/);
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await screen.findByText('Your backup is queued.');
    const first = POST.mock.calls[0]?.[1].body.requestId, second = POST.mock.calls[1]?.[1].body.requestId;
    if (status === 500) expect(second).toBe(first);
    else expect(second).not.toBe(first);
  });
  it('releases a stale retained ID after another admin replaced it and the retry gets 409', async () => {
    POST.mockRejectedValueOnce(new Error('network error'));
    POST.mockImplementationOnce(async () => ({ response: new Response(null, { status: 409 }) }));
    POST.mockImplementationOnce(async (_path: string, input: { body: { requestId: string } }) => {
      state = { ...state, manual: { requestId: input.body.requestId, status: 'queued', requestedAt: now, completedAt: null, snapshotId: null, failure: null } };
      return ok({ data: state });
    });
    const { cache } = start();
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    await screen.findByText(/Unable to confirm the backup request/);
    state.manual = { requestId: uuid(8), status: 'failed', requestedAt: now, completedAt: now, snapshotId: null, failure: null };
    await cache.invalidateQueries({ queryKey: ['health', uuid(1)] });
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back up now' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await screen.findByText('Your backup is queued.');
    expect(POST.mock.calls[0]?.[1]).toEqual(POST.mock.calls[1]?.[1]);
    expect(POST.mock.calls[2]?.[1]).not.toEqual(POST.mock.calls[1]?.[1]);
  });
  it('queues one request, disables while queued, and shows the completed snapshot ID and time', async () => {
    const { cache } = start();
    POST.mockImplementation(async (_path: string, input: { body: { requestId: string } }) => {
      state = { ...state, manual: { requestId: input.body.requestId, status: 'queued', requestedAt: now, completedAt: null, snapshotId: null, failure: null } };
      return ok({ data: state });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    expect(await screen.findByText('Your backup is queued.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Backup in progress…' }).hasAttribute('disabled')).toBe(true);
    expect(POST).toHaveBeenCalledTimes(1);
    state = { ...state, manual: { ...state.manual!, status: 'succeeded', completedAt: now, snapshotId: uuid(2) } };
    await cache.invalidateQueries({ queryKey: ['health', uuid(1)] });
    expect(await screen.findByText(new RegExp('Snapshot ID: ' + uuid(2)))).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back up now' }).hasAttribute('disabled')).toBe(false);
  });
  it('requires the owner checkbox and sends the revision from when the confirmation opened', async () => {
    const { onConfirmed } = start();
    POST.mockImplementation(async () => { state = { ...state, pruningHeld: false, revision: 5 }; return ok({ data: state }); });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the old server is gone' }));
    const confirm = screen.getByRole('button', { name: 'Resume backup pruning' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'The old server is shut down and will not run again.' }));
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledOnce());
    expect(POST).toHaveBeenCalledWith('/api/health/backups/confirm-old-server-gone', { body: { revision: 4, confirmed: true } });
    expect(screen.queryByRole('button', { name: 'Confirm the old server is gone' })).toBeNull();
  });
  it('lets admins request a backup but only owners release pruning', async () => {
    start(false);
    expect(await screen.findByRole('button', { name: 'Back up now' })).toBeDefined();
    expect(screen.getByText(/Ask the owner to confirm/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Confirm the old server is gone' })).toBeNull();
  });
  it('disables requests without backup configuration and hides actions when unavailable', async () => {
    state.configured = false; const { cache } = start();
    expect((await screen.findByRole('button', { name: 'Back up now' })).hasAttribute('disabled')).toBe(true);
    state.available = false; await cache.invalidateQueries({ queryKey: ['health', uuid(1)] });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull());
  });
  it('retries an uncertain response with the same request ID without showing private server errors', async () => {
    POST.mockRejectedValueOnce(new Error('private server configuration'));
    POST.mockImplementationOnce(async (_path: string, input: { body: { requestId: string } }) => {
      state = { ...state, manual: { requestId: input.body.requestId, status: 'queued', requestedAt: now, completedAt: null, snapshotId: null, failure: null } };
      return ok({ data: state });
    });
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Back up now' }));
    await screen.findByText(/Unable to confirm the backup request/);
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }));
    await screen.findByText('Your backup is queued.');
    expect(POST.mock.calls[0]?.[1]).toEqual(POST.mock.calls[1]?.[1]);
    expect(document.body.textContent).not.toContain('private server configuration');
  });
  it.each([
    ['credentials_rejected', 'Your backup failed: the storage destination rejected the access key. Replace the storage credentials in Settings → Integrations → Backups.'],
    ['bucket_missing', "Your backup failed: the bucket doesn't exist. Check the bucket name in Settings → Integrations → Backups."],
    ['endpoint_unreachable', "Your backup failed: the storage endpoint couldn't be reached. Check the endpoint address and try again."],
    ['other', 'Your backup failed. Check backup settings and System health before trying again.'],
    [null, 'Your backup failed. Check backup settings and System health before trying again.'],
  ] as const)('names the %s cause of a failed backup', async (failure, text) => {
    state.manual = { requestId: uuid(9), status: 'failed', requestedAt: now, completedAt: now, snapshotId: null, failure };
    state.pruningHeld = false;
    start();
    expect((await screen.findByText(text)).getAttribute('role')).toBe('status');
  });
  it('says what pruning keeps and deletes before the owner confirms', async () => {
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm the old server is gone' }));
    expect(screen.getByText(/keeps 24 hourly, 7 nightly and 4 weekly snapshots.*deletes the other snapshots in this bucket/)).toBeDefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { HealthTile } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { FailedJobsActions } from './failed-jobs.js';
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn(), POST: vi.fn() } }));

const checkedAt = '2026-10-22T12:00:00.000Z';
const tile = (failed: number): HealthTile => ({ id: 'failed_jobs', status: failed ? 'error' : 'healthy', checkedAt, message: 'Background jobs',
  details: { failed, pending: 0, running: 0, oldestFailureAt: failed ? '2026-10-22T10:00:00.000Z' : null } });
const POST = vi.mocked(api.POST);

/** Reads the tiles as the Health page does, under ['health', gymId], and renders the tile's action. */
function Harness({ tiles }: { tiles: () => Promise<HealthTile[]> }) {
  const query = useQuery({ queryKey: ['health', 'gym-a'], queryFn: tiles });
  return query.data ? <FailedJobsActions gymId="gym-a" tile={query.data.find(found => found.id === 'failed_jobs')}/> : null;
}
function start(failed: number) {
  const tiles = vi.fn(async () => [tile(failed)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness tiles={tiles}/></QueryClientProvider>);
  return { tiles };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('asks before acknowledging, posts the tile\'s check time once, closes and refetches the tiles', async () => {
  POST.mockResolvedValue({ response: new Response(), data: { data: { acknowledged: 2 } } } as never);
  const { tiles } = start(2);
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge failed jobs' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/doesn't run them again or undo anything they did/)).toBeDefined();
  expect(POST).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenCalledTimes(1);
  expect(POST).toHaveBeenCalledWith('/api/health/failed-jobs/acknowledge', { body: { through: checkedAt } });
  await waitFor(() => expect(tiles).toHaveBeenCalledTimes(2));
});

it('keeps the original cutoff when the tile refreshes during confirmation', async () => {
  POST.mockResolvedValue({ response: new Response(), data: { data: { acknowledged: 2 } } } as never);
  const client = new QueryClient();
  const view = render(<FailedJobsActions gymId="gym-a" tile={tile(2)}/>, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge failed jobs' }));
  view.rerender(<FailedJobsActions gymId="gym-a" tile={{ ...tile(3), checkedAt: '2026-10-22T12:01:00.000Z' }}/>);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenCalledWith('/api/health/failed-jobs/acknowledge', { body: { through: checkedAt } });
});

it('keeps the dialog open with an error when acknowledging fails', async () => {
  POST.mockResolvedValue({ response: new Response(null, { status: 500 }), data: undefined } as never);
  start(2);
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge failed jobs' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
  expect(await within(dialog).findByText('The failed jobs could not be acknowledged. Try again.')).toBeDefined();
  expect(screen.getByRole('dialog')).toBeDefined();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenCalledTimes(1);
});

it('shows no action without failed jobs or a check time', async () => {
  const { tiles } = start(0);
  await waitFor(() => expect(tiles).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
  cleanup();
  render(<FailedJobsActions gymId="gym-a" tile={{ ...tile(2), checkedAt: null }}/>, {
    wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });
  expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
  render(<FailedJobsActions gymId="gym-a" tile={undefined}/>, {
    wrapper: ({ children }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider> });
  expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
});

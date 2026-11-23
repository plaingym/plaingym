// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver, useQuery } from '@tanstack/react-query';
import { healthTileIds, type HealthTile } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { FailedJobsActions, parseHealthResponse } from './failed-jobs.js';
import { HealthPage } from './page.js';
vi.mock('../../lib/api.js', () => ({ api: { GET: vi.fn(), POST: vi.fn() } }));
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));

const checkedAt = '2026-10-22T12:00:00.000Z';
const tile = (failed: number, failedVersion = failed ? 'version-' + failed : 'none'): HealthTile => ({ id: 'failed_jobs',
  status: failed ? 'error' : 'healthy', checkedAt, message: 'Background jobs',
  details: { failed, pending: 0, running: 0, oldestFailureAt: failed ? '2026-10-22T10:00:00.000Z' : null, failedVersion } });
const POST = vi.mocked(api.POST);

/** Reads the tiles as the Health page does, under ['health', gymId], and renders the tile's action. */
function Harness({ tiles }: { tiles: () => Promise<HealthTile[]> }) {
  const query = useQuery({ queryKey: ['health', 'gym-a'], queryFn: tiles });
  return query.data ? <FailedJobsActions gymId="gym-a" tile={query.data.find(found => found.id === 'failed_jobs')}/> : null;
}
function start(failed: number, refreshed = failed) {
  const tiles = vi.fn(async () => [tile(refreshed)]).mockResolvedValueOnce([tile(failed)]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness tiles={tiles}/></QueryClientProvider>);
  return { tiles };
}
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('asks before acknowledging, posts the tile\'s check time and version once, closes and refetches the tiles', async () => {
  POST.mockResolvedValue({ response: new Response(), data: { data: { acknowledged: 2 } } } as never);
  const { tiles } = start(2);
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge failed jobs' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText(/exactly the failed jobs counted here/)).toBeDefined();
  expect(within(dialog).getByText(/doesn't run them again or undo anything they did/)).toBeDefined();
  expect(POST).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenCalledTimes(1);
  expect(POST).toHaveBeenCalledWith('/api/health/failed-jobs/acknowledge', { body: { through: checkedAt, failedVersion: 'version-2' } });
  await waitFor(() => expect(tiles).toHaveBeenCalledTimes(2));
});

it('keeps the check time and version the dialog opened on when the tile refreshes during confirmation', async () => {
  POST.mockResolvedValue({ response: new Response(), data: { data: { acknowledged: 2 } } } as never);
  const client = new QueryClient();
  const view = render(<FailedJobsActions gymId="gym-a" tile={tile(2)}/>, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge failed jobs' }));
  view.rerender(<FailedJobsActions gymId="gym-a" tile={{ ...tile(3), checkedAt: '2026-10-22T12:01:00.000Z' }}/>);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenCalledWith('/api/health/failed-jobs/acknowledge', { body: { through: checkedAt, failedVersion: 'version-2' } });
});

it.each([0, 3])('returns the owner to the refreshed tile after a conflict (%i failures remain)', async refreshed => {
  POST.mockResolvedValueOnce({ response: new Response(null, { status: 409 }), data: undefined } as never);
  const { tiles } = start(2, refreshed);
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge failed jobs' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
  expect(await within(dialog).findByText('The failed jobs changed. Check the count and try again.')).toBeDefined();
  expect(within(dialog).queryByText('The failed jobs could not be acknowledged. Try again.')).toBeNull();
  await waitFor(() => expect(tiles).toHaveBeenCalledTimes(2));
  expect(within(dialog).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review Background jobs' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(POST).toHaveBeenCalledTimes(1);
  if (refreshed === 0) {
    expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
    return;
  }
  POST.mockResolvedValueOnce({ response: new Response(), data: { data: { acknowledged: refreshed } } } as never);
  fireEvent.click(screen.getByRole('button', { name: 'Acknowledge failed jobs' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Acknowledge' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(POST).toHaveBeenLastCalledWith('/api/health/failed-jobs/acknowledge',
    { body: { through: checkedAt, failedVersion: 'version-' + refreshed } });
});

it('keeps the dialog open with an error when acknowledging fails', async () => {
  POST.mockResolvedValue({ response: new Response(null, { status: 500 }), data: undefined } as never);
  const { tiles } = start(2);
  fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge failed jobs' }));
  const dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Acknowledge' }));
  expect(await within(dialog).findByText('The failed jobs could not be acknowledged. Try again.')).toBeDefined();
  expect(screen.getByRole('dialog')).toBeDefined();
  expect(tiles).toHaveBeenCalledTimes(1);
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

describe('a Health response from a server before failed jobs could be acknowledged', () => {
  /** Every tile not set up, apart from a Background jobs tile with failures and a healthy Email tile. */
  const response = (failedJobs: Record<string, unknown>, smtp: Record<string, unknown> = { configured: true, lastTestAt: null }) =>
    ({ data: { generatedAt: checkedAt, tiles: healthTileIds.map(id =>
    id === 'failed_jobs' ? { id, status: 'error', checkedAt, message: 'Background jobs failed', details: failedJobs }
      : id === 'smtp' ? { id, status: 'healthy', checkedAt, message: 'Email works', details: smtp }
        : { id, status: 'not_configured', checkedAt: null, message: 'Not set up', details: null }) } });
  const legacy = { failed: 2, pending: 0, running: 0, oldestFailureAt: '2026-10-22T10:00:00.000Z' };
  function page(body: unknown) {
    const data: ShellBootstrap = { gym: { id: 'gym-a', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: 'owner', displayName: 'Test User', roles: ['owner'], member: false }, login: { password: true, magicLink: false } };
    vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data,
      initialData: data }).getCurrentResult());
    vi.mocked(api.GET).mockImplementation((async (path: string) => ({ response: new Response(), data: path === '/api/health/backups'
      ? { data: { available: true, configured: true, pruningHeld: false, revision: 1, manual: null } } : body })) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><HealthPage/></QueryClientProvider>);
  }

  it('shows the Background jobs tile and the other tiles, with no load error and no Acknowledge action', async () => {
    page(response(legacy));
    const jobs = await screen.findByRole('region', { name: 'Background jobs' });
    expect(within(jobs).getByText('Background jobs failed')).toBeDefined();
    expect(within(jobs).getByText('Failed jobs').nextSibling?.textContent).toBe('2');
    const email = screen.getByRole('region', { name: 'Email' });
    expect(within(email).getByText('Email works')).toBeDefined();
    expect(screen.queryByText('Unable to load system health. Try again.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
  });

  it('still offers the action when the tile carries a version', async () => {
    page(response({ ...legacy, failedVersion: 'version-2' }));
    const jobs = await screen.findByRole('region', { name: 'Background jobs' });
    expect(within(jobs).getByRole('button', { name: 'Acknowledge failed jobs' })).toBeDefined();
  });

  it('closes an open confirmation when a refresh returns an older tile without a version', () => {
    const client = new QueryClient();
    const view = render(<FailedJobsActions gymId="gym-a" tile={tile(2)}/>, {
      wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge failed jobs' }));
    expect(screen.getByRole('dialog')).toBeDefined();
    const older = parseHealthResponse(response(legacy)).tiles.find(found => found.id === 'failed_jobs');
    view.rerender(<FailedJobsActions gymId="gym-a" tile={older}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Acknowledge failed jobs' })).toBeNull();
    view.rerender(<FailedJobsActions gymId="gym-a" tile={tile(2)}/>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Acknowledge failed jobs' })).toBeDefined();
    expect(POST).not.toHaveBeenCalled();
  });

  it('accepts only the missing version: every other field stays as strict as the contract', () => {
    const tiles = parseHealthResponse(response(legacy)).tiles;
    const jobs = tiles.find(found => found.id === 'failed_jobs');
    expect(jobs?.details).toEqual(legacy);
    expect(jobs?.details && Object.hasOwn(jobs.details, 'failedVersion')).toBe(false);
    expect(parseHealthResponse(response({ ...legacy, failedVersion: 'version-2' })).tiles.find(found => found.id === 'failed_jobs')?.details)
      .toEqual({ ...legacy, failedVersion: 'version-2' });
    const withoutCount: Record<string, unknown> = { ...legacy };
    delete withoutCount.failed;
    expect(() => parseHealthResponse(response(withoutCount))).toThrow();
    expect(() => parseHealthResponse(response({ ...legacy, failedVersion: '' }))).toThrow();
    // Another tile missing a required field still fails the whole response.
    expect(() => parseHealthResponse(response(legacy, { configured: true }))).toThrow();
  });
});

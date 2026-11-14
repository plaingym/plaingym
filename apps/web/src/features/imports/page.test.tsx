// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import { exportDatasets } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { t } from '../../lib/i18n.js';
import { ImportsPage } from './page.js';
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../../lib/api.js', async importOriginal => ({ ...await importOriginal<typeof import('../../lib/api.js')>(), createJsonTransport: () => request }));
const id = '00000000-0000-7000-8000-000000000001', runId = '00000000-0000-7000-8000-000000000002';
const createdAt = '2026-10-22T12:00:00Z';
const uploaded = { id, filename: 'people.csv', rowCount: 1, columns: ['Name'],
  suggestedMapping: [{ sourceColumn: 'Name', targetField: 'firstName' }], expiresAt: createdAt };
function bootstrap(roles: StaffRole[] = ['owner']) {
  const data: ShellBootstrap = { gym: { id, name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: id, displayName: 'Test User', roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], queryFn: async () => data, initialData: data }).getCurrentResult());
}
const clients: QueryClient[] = [];
function start() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client);
  return render(<QueryClientProvider client={client}><ImportsPage/></QueryClientProvider>);
}
beforeEach(() => { bootstrap(); request.mockReset(); });
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.unstubAllGlobals(); });
describe('CSV admin workflow', () => {
  it.each([
    { status: 500, code: 'unavailable', message: 'Private server detail' },
    { status: 503, code: 'unknown', message: 'Private server detail' },
    { status: 503, code: 'unavailable', message: 'x'.repeat(2001) },
    { status: 503, code: 'unavailable', message: '   ' },
  ])('hides unapproved preview messages: $status $code', async ({ status, code, message }) => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/imports/uploads'
      ? Response.json({ data: uploaded }) : Response.json({ error: { code, message } }, { status })));
    start();
    fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [new File(['Name\nTest'], 'people.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The request failed. Please try again.');
  });
  it.each([
    { label: 'Import type', value: 'memberships' },
    { label: 'Duplicates', value: 'skip' },
    { label: 'Name', value: 'lastName' },
  ])('clears preview errors when the plan changes: $label', async ({ label, value }) => {
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/imports/uploads'
      ? Response.json({ data: uploaded }) : Response.json({ error: { code: 'unavailable', message: 'Retry later' } }, { status: 503 })));
    start();
    fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [new File(['Name\nTest'], 'people.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it.each([
    { status: 400, code: 'invalid_request', key: 'invalidMapping' },
    { status: 404, code: 'not_found', key: 'notFound' },
  ])('shows the API explanation for a preview $status', async ({ status, code, key }) => {
    const message = t('imports/pipeline:' + key);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/imports/uploads'
      ? Response.json({ data: uploaded }) : Response.json({ error: { code, message } }, { status })));
    start();
    fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [new File(['Name\nTest'], 'people.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });
  it.each([true, false])('shows a preview 503 message with a safe fallback (JSON: %s)', async (json) => {
    const message = t('imports/pipeline:previewTimedOut');
    expect(message).toContain('Split the file');
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/imports/uploads'
      ? Response.json({ data: uploaded })
      : json ? Response.json({ error: { code: 'unavailable', message } }, { status: 503 })
        : new Response('upstream failed', { status: 503 })));
    start();
    fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [new File(['Name\nTest'], 'people.csv')] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain(json ? message : 'The request failed. Please try again.');
    expect(document.body.textContent).not.toContain('upstream failed');
  });
  it('keeps a preview message from standing in for a later failure or a new upload', async () => {
    const message = t('imports/pipeline:previewTimedOut'), file = new File(['Name\nTest'], 'people.csv');
    const answers = [Response.json({ data: uploaded }), new Response(null, { status: 500 }), Response.json({ data: uploaded })];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => path === '/api/imports/uploads' ? answers.shift()!
      : Response.json({ error: { code: 'unavailable', message } }, { status: 503 })));
    start();
    const upload = () => fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [file] } });
    upload();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    upload();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The request failed. Please try again.'));
    upload();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it.each(['coach', 'front_desk', 'member'] as const)('does not expose imports or exports to %s', (role) => {
    bootstrap(role === 'member' ? [] : [role]); start();
    expect(screen.getByRole('alert').textContent).toContain('do not have permission'); expect(request).not.toHaveBeenCalled();
  });
  it('uploads, previews escaped values, and requires a successful dry run for the current mapping before commit', async () => {
    const job = { id: runId, uploadId: id, mapper: 'people', dryRun: true, status: 'succeeded', totalRows: 1, processedRows: 1,
      committedRows: 0, errorCount: 0, createdAt, completedAt: createdAt };
    request.mockImplementation(async (path: string) => {
      if (path === '/api/imports') return { data: { ...job, status: 'pending', processedRows: 0, completedAt: null } };
      return { data: job };
    });
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/imports/uploads') return Response.json({ data: { id, filename: 'people.csv', rowCount: 1, columns: ['Name'],
        suggestedMapping: [{ sourceColumn: 'Name', targetField: 'firstName' }], expiresAt: createdAt } });
      return Response.json({ data: [{ rowNumber: 2, values: { firstName: '<script>secret()</script>' }, action: 'create', duplicateIds: [] }],
        pagination: { limit: 50, offset: 0, total: 1 }, summary: { totalRows: 1, create: 1, update: 0, skip: 0, errors: 0 } });
    }));
    start();
    fireEvent.change(screen.getByLabelText(/CSV file/), { target: { files: [new File(['Name\nTest'], 'people.csv', { type: 'text/csv' })] } });
    await screen.findByRole('button', { name: 'Preview' });
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText(/<script>secret/); expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'First name' })).toBeDefined();
    expect(screen.queryByRole('columnheader', { name: 'Values' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    expect(request).toHaveBeenCalledWith('/api/imports', expect.objectContaining({ dryRun: true, uploadId: id }));
    fireEvent.change(screen.getByLabelText('Import type'), { target: { value: 'mat' } });
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('offers the expiring download after the export finishes and hides internal errors', async () => {
    const job = { id: runId, datasets: [...exportDatasets], createdAt, status: 'succeeded', completedAt: createdAt,
      downloadUrl: 'https://files.example.test/export.zip', expiresAt: '2026-10-22T13:00:00Z' };
    request.mockImplementation(async (path: string) => ({ data: path === '/api/exports' ? { ...job, status: 'pending', completedAt: null, downloadUrl: null, expiresAt: null } : job }));
    start(); fireEvent.click(screen.getByRole('button', { name: 'Create export' }));
    expect((await screen.findByRole('link', { name: 'Download CSV archive' })).getAttribute('href')).toBe(job.downloadUrl);
    request.mockRejectedValueOnce(new Error('private SQL password'));
    fireEvent.click(screen.getByRole('button', { name: 'Create export' }));
    expect((await screen.findByRole('alert')).textContent).toContain('request failed');
    expect(document.body.textContent).not.toContain('private SQL');
  });
});

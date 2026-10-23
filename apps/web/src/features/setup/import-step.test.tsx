// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportStep } from './import-step.js';
import { registration } from './import-step.registrations.js';

const uploadId = '019aa4a0-0000-7000-8000-000000000010', dryId = '019aa4a0-0000-7000-8000-000000000011', runId = '019aa4a0-0000-7000-8000-000000000012';
const job = (id: string, dryRun: boolean, status: string, committedRows = 0) => ({ id, uploadId, mapper: 'people', dryRun, status, totalRows: 2,
  processedRows: status === 'pending' ? 0 : 2, committedRows, errorCount: 0, createdAt: '2026-10-22T12:00:00Z',
  completedAt: status === 'succeeded' ? '2026-10-22T12:01:00Z' : null });
function server(options: { finish?: number; failProgressOnce?: boolean; dryFails?: boolean; partialCommit?: boolean; errorPages?: boolean; deferredBackups?: boolean } = {}) {
  const polls = new Map<string, number>();
  let progressFailed = false;
  let errorsFailed = false;
  let policy = 'error';
  const fetcher = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
    const name = String(path), body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (name === '/api/setup') return Response.json({ data: options.deferredBackups ? { currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6], completed: false, revision: 9 }
      : { currentStep: 8, completedSteps: [0, 1, 2, 3, 4, 5, 6, 7], completed: false, revision: 9 } });
    if (name === '/api/setup/finish') return options.finish ? Response.json({ error: 'failed' }, { status: options.finish })
      : Response.json({ data: { completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: 10 } });
    if (name === '/api/imports/uploads') return Response.json({ data: { id: uploadId, filename: 'members.csv', rowCount: 2, columns: ['First', 'Last'],
      suggestedMapping: [{ sourceColumn: 'First', targetField: 'firstName' }, { sourceColumn: 'Last', targetField: 'lastName' }], expiresAt: '2026-10-23T12:00:00Z' } });
    if (name === '/api/imports') { policy = String(body.duplicatePolicy); return Response.json({ data: job(body.dryRun ? dryId : runId, Boolean(body.dryRun), 'pending') }); }
    if (name.includes('/errors?')) {
      if (options.errorPages && !errorsFailed) { errorsFailed = true; return Response.json({ error: 'private detail' }, { status: 503 }); }
      const offset = Number(new URL(name, 'https://gym.example').searchParams.get('offset'));
      return Response.json({ data: [{ rowNumber: 3 + offset, column: 'Last', code: 'missing_required', message: 'Last name is required.' }],
        pagination: { limit: 50, offset, total: options.errorPages ? 51 : 1 } });
    }
    if (options.failProgressOnce && !progressFailed) {
      progressFailed = true;
      return Response.json({ error: 'private provider detail' }, { status: 503 });
    }
    const id = name.slice('/api/imports/'.length), count = (polls.get(id) ?? 0) + 1;
    polls.set(id, count);
    if (options.dryFails && id === dryId) return Response.json({ data: { ...job(id, true, 'failed'), errorCount: 1 } });
    if (options.partialCommit && id === runId && policy === 'error') return Response.json({ data: { ...job(id, false, 'failed', 1), errorCount: 1 } });
    return Response.json({ data: job(id, id === dryId, count > 1 ? 'succeeded' : 'running', id === runId && count > 1 ? 2 : 0) });
  });
  return fetcher;
}
const finishBody = (fetcher: ReturnType<typeof server>) => JSON.parse(String(fetcher.mock.calls.find(([path]) => path === '/api/setup/finish')![1]!.body)) as unknown;
beforeEach(() => { sessionStorage.clear(); });
afterEach(cleanup);
describe('setup step 8: import or start fresh', () => {
  it('registers the step for the wizard', () => {
    expect(registration.setupSteps?.[0]).toMatchObject({ id: 'setupSteps.setup.import', enabled: true });
  });
  it('starts fresh with the current revision and says billing and member emails stay off', async () => {
    const fetcher = server(), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    expect(screen.getByText(/Billing and member emails stay off/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(finishBody(fetcher)).toEqual({ choice: 'fresh', revision: 9 });
  });
  it('defers backups when the backup step was not completed', async () => {
    const fetcher = server({ deferredBackups: true }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(finishBody(fetcher)).toEqual({ choice: 'fresh', revision: 9, skipBackups: true });
  });
  it('uploads, checks with a dry run, commits, and finishes with the committed import', async () => {
    const fetcher = server(), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\nAna,Silva\n'], 'members.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/members\.csv/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText(/This was a dry run/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Finish with this import' })).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    const commit = fetcher.mock.calls.filter(([path]) => path === '/api/imports').map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
    expect(commit).toEqual([expect.objectContaining({ uploadId, mapper: 'people', dryRun: true, duplicatePolicy: 'error' }),
      expect.objectContaining({ uploadId, dryRun: false })]);
    const finish = await screen.findByRole('button', { name: 'Finish with this import' });
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/CSV file/) as HTMLInputElement).disabled).toBe(true);
    await user.click(finish);
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(finishBody(fetcher)).toEqual({ choice: 'import', revision: 9, importId: runId });
  });
  it('retries and pages row errors without starting another import', async () => {
    const fetcher = server({ dryFails: true, errorPages: true }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\nAna,\n'], 'members.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    await user.click(await screen.findByRole('button', { name: 'Try loading errors again' }));
    expect(await screen.findByText(/Row 3: Last name is required/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/Row 53: Last name is required/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await screen.findByText(/Row 3: Last name is required/)).toBeDefined();
    expect(screen.queryByText('private detail')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/imports')).toHaveLength(1);
  });
  it('recovers from a progress error by reading the same run without starting a second import', async () => {
    const fetcher = server({ failProgressOnce: true }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\nAna,Silva\n'], 'members.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    await user.click(await screen.findByRole('button', { name: 'Try checking progress again' }));
    expect(await screen.findByText(/This was a dry run/)).toBeDefined();
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/imports')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Finish with this import' })).toBeNull();
    expect(document.body.textContent).not.toContain('private provider');
  });
  it('keeps commit disabled when the dry run reports errors', async () => {
    const fetcher = server({ dryFails: true }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\nAna,Silva\n'], 'members.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText('Import status: Failed')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Finish with this import' })).toBeNull();
  });
  it.each(['skip', 'update'])('recovers a partial import with %s and requires a new dry run', async (policy) => {
    const fetcher = server({ partialCommit: true }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    const file = new File(['First,Last\nAna,Silva\nJo,\n'], 'members.csv', { type: 'text/csv' });
    await user.upload(screen.getByLabelText(/CSV file/), file);
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    expect(await screen.findByText(/Some rows were saved/)).toBeDefined();
    expect(await screen.findByText(/Row 3: Last name is required/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Finish with this import' })).toBeNull();
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\nAna,Silva\nJo,Fields\n'], 'corrected.csv', { type: 'text/csv' }));
    await user.selectOptions(screen.getByLabelText('Duplicates'), policy);
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    // A policy change invalidates a successful dry run too.
    await user.selectOptions(screen.getByLabelText('Duplicates'), 'error');
    expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Duplicates'), policy);
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await user.click(await screen.findByRole('button', { name: 'Finish with this import' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    const starts = fetcher.mock.calls.filter(([path]) => path === '/api/imports').map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>);
    expect(starts.slice(-2)).toEqual([expect.objectContaining({ duplicatePolicy: policy, dryRun: true }), expect.objectContaining({ duplicatePolicy: policy, dryRun: false })]);
  });
  it('shows a revision conflict without claiming setup finished', async () => {
    const fetcher = server({ finish: 409 }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch}/>);
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup changed elsewhere/)).toBeDefined();
    expect(screen.queryByText(/Setup is complete/)).toBeNull();
  });
  it('shows a safe message when the server rejects the import', async () => {
    const fetcher = server({ finish: 400 }), user = userEvent.setup();
    render(<ImportStep fetcher={fetcher as typeof fetch} pollMs={1}/>);
    await user.click(screen.getByRole('button', { name: 'Import a CSV' }));
    await user.upload(screen.getByLabelText(/CSV file/), new File(['First,Last\n'], 'members.csv', { type: 'text/csv' }));
    await user.click(await screen.findByRole('button', { name: 'Dry run' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Commit import' }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Commit import' }));
    await user.click(await screen.findByRole('button', { name: 'Finish with this import' }));
    expect((await screen.findByText(/Choose a finished, committed import/))).toBeDefined();
    expect(screen.queryByText(/Setup is complete/)).toBeNull();
  });
});

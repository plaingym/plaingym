// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PortalClient } from '../schedule/client.js';
import { PortalProgressPage } from './page.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } } }) }));
const parent = '00000000-0000-7000-8000-000000000001', child = '00000000-0000-7000-8000-000000000002';
const program = '00000000-0000-7000-8000-000000000003', first = '00000000-0000-7000-8000-000000000004', second = '00000000-0000-7000-8000-000000000005';
const progress = {
  history: [{ id: 'h1', memberId: child, programId: program, rankId: first, rankSystemId: program, subRank: 1, promotedAt: '2026-10-01T00:00:00.000Z' }],
  programs: [{ id: program, name: 'Grappling', current: { rankId: first, subRank: 1 }, next: { rankId: second, subRank: 0 } }],
  ranks: [{ id: first, name: 'First', color: '#ffffff', subRanks: [{ id: 'one', name: 'One stripe' }] }, { id: second, name: 'Second', color: '#0000ff', subRanks: [] }],
  criteria: [{ programId: program, rankId: second, criterionId: 'classes-since-promotion', labelKey: 'ranks/ranks:classes', current: 1, required: 2, eligible: false }],
};
const visit = (n: number) => ({ id: 'v' + n, memberId: child, sessionId: null, programId: program, occurredAt: `2026-10-${10 + n}T18:00:00.000Z`, source: 'kiosk', kind: n === 1 ? 'open_mat' : 'class' });
const client = { context: vi.fn(), members: vi.fn(), progress: vi.fn(), attendance: vi.fn() };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.context.mockResolvedValue({ role: 'payer', householdId: parent, memberId: parent });
  client.members.mockResolvedValue([{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent' }]);
  client.progress.mockImplementation(async (memberId: string) => memberId === child ? progress : { history: [], programs: [], ranks: [], criteria: [] });
  client.attendance.mockImplementation(async (memberId: string, offset: number) => memberId !== child ? { data: [], pagination: { limit: 20, offset, total: 0 } }
    : { data: [visit(offset + 1)], pagination: { limit: 1, offset, total: 2 } });
});
afterEach(cleanup);
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PortalProgressPage client={client as unknown as PortalClient} /></QueryClientProvider>);

describe('portal progress', () => {
  it("a parent sees a child's rank, next step, criterion bars and attendance", async () => {
    const user = userEvent.setup(); page();
    await screen.findByText('No ranks yet');
    await user.selectOptions(screen.getByLabelText('Progress for'), child);
    await screen.findByText('Current: First, One stripe');
    expect(screen.getByText('Next: Second')).toBeDefined();
    expect(screen.getByRole('progressbar', { name: 'Classes since promotion Grappling' }).getAttribute('value')).toBe('1');
    expect(screen.getByText('Grappling · First, One stripe')).toBeDefined();
    await screen.findByText('Open mat · Grappling');
    expect(screen.getByText('Visits: 2')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    await screen.findByText('Class · Grappling');
    expect(client.attendance).toHaveBeenLastCalledWith(child, 1);
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
  it('shows the current rank the server chose, even when a same-time promotion is listed first', async () => {
    const tied = { ...progress.history[0], id: 'h2', subRank: 0 };
    client.progress.mockResolvedValue({ ...progress, history: [tied, ...progress.history] });
    page();
    await screen.findByText('Current: First, One stripe');
    expect(screen.queryByText('Current: First')).toBeNull();
  });
  it('explains a program without a current rank', async () => {
    client.progress.mockResolvedValue({ ...progress, programs: [{ ...progress.programs[0], current: null }] });
    page();
    await screen.findByText('No rank yet in this program.');
    expect(screen.getByText('Next: Second')).toBeDefined();
  });
  it('marks the top rank', async () => {
    client.progress.mockResolvedValue({ ...progress, programs: [{ ...progress.programs[0], next: null }], criteria: [] });
    page();
    await screen.findByText('No further rank in this program.');
  });
  it('marks met requirements while the coach still decides', async () => {
    client.progress.mockResolvedValue({ ...progress, criteria: [{ ...progress.criteria[0], current: 2, eligible: true }] });
    page();
    await screen.findByText('Requirements met');
  });
});

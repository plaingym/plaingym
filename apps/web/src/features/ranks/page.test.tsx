// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWebRegistries } from '@plaingym/shared';
import type { Member, Rank, RankSystem, Program, PromotionEligibility, Promotion } from '@plaingym/shared/contracts';
import { ApiError } from '../../lib/api.js';
import type { RanksClient } from './api.js';
import { RanksWorkspace } from './page.js';
import { RankEditor } from './rank-editor.js';
import { MemberRanksPanel, MemberRanksTab } from './member-tab.js';
import { registration } from './registrations.js';

const id = (value: number) => '019a0af0-9c00-7000-8000-' + String(value).padStart(12, '0');
const gymId = id(1), memberId = id(5), secondMemberId = id(6), createdAt = '2026-09-01T12:00:00.000Z';
const system: RankSystem = { id: id(2), gymId, name: 'Adult progression', installedPackId: null, revision: 1, createdAt };
const program: Program = { id: id(3), gymId, name: 'Adults', rankSystemId: system.id, revision: 1, active: true, createdAt };
const rank: Rank = { id: id(4), gymId, name: 'Foundation', rankSystemId: system.id, position: 0, color: '#ffffff',
  subRanks: [{ id: 'tip', name: 'Tip' }], criteria: [{ providerId: 'classes-since-promotion', config: { target: 10 } },
    { providerId: 'skills', config: { target: 2 } }], revision: 3, createdAt };
const eligibility: PromotionEligibility[] = [memberId, secondMemberId].map((memberId, subRank) => ({ memberId,
  program: { id: program.id, rankSystemId: system.id }, rank: { id: rank.id, rankSystemId: system.id },
  rankSystemId: system.id, subRank, eligible: true, criteria: [{ providerId: 'classes-since-promotion', labelKey: 'ranks/ranks:classes', current: 11, target: 10, met: true }] }));
function member(memberId: string, firstName: string): Member {
  return { id: memberId, householdId: id(9), firstName, lastName: 'Student', email: null, phone: null, photoKey: null,
    dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, anonymizedAt: null, revision: 1, createdAt, emailDeliverable: true };
}
function makeClient() {
  return { systems: vi.fn(async () => [system]), programs: vi.fn(async () => [program]), ranks: vi.fn(async () => [rank]),
    eligibility: vi.fn(async () => eligibility), members: vi.fn(async () => [member(memberId, 'Ada'), member(secondMemberId, 'Bo')]),
    history: vi.fn(async (): Promise<Promotion[]> => []), call: vi.fn(async () => ({ data: {} })) as unknown as RanksClient['call'],
  } satisfies RanksClient;
}
function start(view: React.ReactNode) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { cache, ...render(<QueryClientProvider client={cache}>{view}</QueryClientProvider>) };
}
afterEach(cleanup);

describe('rank management', () => {
  it('edits names, belt colors and sub-ranks, preserving module criteria and stable sub-rank IDs', async () => {
    const save = vi.fn(async () => {});
    render(<RankEditor rank={rank} rankSystemId={system.id} nextPosition={1} busy={false} save={save} cancel={() => {}}/>);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Our foundation' } });
    fireEvent.change(screen.getByLabelText('Belt color'), { target: { value: '#123abc' } });
    fireEvent.change(screen.getByLabelText('Sub-rank 1'), { target: { value: 'Degree' } });
    fireEvent.change(screen.getByLabelText('Order (use an unused position)'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Our foundation', color: '#123abc', position: 5,
      subRanks: [{ id: 'tip', name: 'Degree' }], criteria: [{ providerId: 'skills', config: { target: 2 } }, { providerId: 'classes-since-promotion', config: { target: 10 } }] })));
  });
  it('bulk promotes mixed base ranks and sub-ranks with the correct shared system', async () => {
    const client = makeClient(); start(<RanksWorkspace gymId={gymId} configure promote client={client}/>);
    await screen.findByText('Ada Student — Ready (Sub-rank 0)');
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('Ada Student — Ready (Sub-rank 0)'));
    fireEvent.click(screen.getByLabelText('Bo Student — Ready (Sub-rank 1)'));
    fireEvent.change(screen.getByLabelText('Promotion date and time'), { target: { value: '2026-10-22T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote selected (2)' }));
    await waitFor(() => expect(client.call).toHaveBeenCalledTimes(2));
    expect(client.call).toHaveBeenCalledWith('bulkPromote', expect.objectContaining({ memberIds: [memberId], subRank: 0, rankSystemId: system.id, rankId: rank.id, programId: program.id }));
    expect(client.call).toHaveBeenCalledWith('bulkPromote', expect.objectContaining({ memberIds: [secondMemberId], subRank: 1 }));
  });
  it('keeps settings and promotions hidden from front desk while rendering rank definitions', async () => {
    const client = makeClient(); start(<RanksWorkspace gymId={gymId} configure={false} promote={false} client={client}/>);
    await screen.findByText('0. Foundation');
    expect(screen.queryByRole('heading', { name: 'Configure ranks' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Ready for Promotion' })).toBeNull();
    expect(client.eligibility).not.toHaveBeenCalled(); expect(client.members).not.toHaveBeenCalled();
  });
  it('sends the read revision and keeps the editor open on a conflict', async () => {
    const client = makeClient(); vi.mocked(client.call).mockRejectedValue(new ApiError(409, 'conflict'));
    start(<RanksWorkspace gymId={gymId} configure promote={false} client={client}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Foundation' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited' } });
    const editor = screen.getByRole('heading', { name: 'Edit rank' }).closest('form')!;
    fireEvent.submit(editor);
    await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateRank', expect.objectContaining({ revision: 3, name: 'Edited' }), rank.id));
    await screen.findByText(/The record changed or the change conflicts/);
    expect(screen.getByRole('heading', { name: 'Edit rank' })).toBeDefined();
  });
  it('registers a real member tab and renders promotion history with its rank system', async () => {
    const registries = createWebRegistries([registration]);
    expect(registries.memberTabs.all()[0]).toMatchObject({ enabled: true, component: MemberRanksTab });
    const client = makeClient(); client.history.mockResolvedValue([{ id: id(10), gymId, memberId, programId: program.id, rankId: rank.id,
      rankSystemId: system.id, subRank: 1, promotedAt: createdAt, promotedBy: null, notes: 'Excellent work', createdAt }]);
    start(<MemberRanksPanel gymId={gymId} memberId={memberId} promote={false} client={client}/>);
    await screen.findByText('Adults — Foundation Tip');
    expect(screen.getByText('Rank system: Adult progression').closest('li')?.getAttribute('data-rank-system')).toBe(system.id);
    expect(screen.getByText('Excellent work')).toBeDefined();
    expect(client.history).toHaveBeenCalledWith(memberId);
    expect(client.eligibility).not.toHaveBeenCalled();
  });
  it('records a single promotion from the member profile with the selected sub-rank', async () => {
    const client = makeClient(); start(<MemberRanksPanel gymId={gymId} memberId={memberId} promote client={client}/>);
    await screen.findByText('No promotions recorded yet.');
    fireEvent.change(screen.getByLabelText('Sub-rank'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Promotion date and time'), { target: { value: '2026-10-22T12:00' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Coach reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record promotion' }));
    await waitFor(() => expect(client.call).toHaveBeenCalledWith('promote', expect.objectContaining({ memberId, rankSystemId: system.id, subRank: 1, notes: 'Coach reviewed' })));
  });
});

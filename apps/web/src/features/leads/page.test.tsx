// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ClassSession, LeadStage } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import { visibleAdminNavigation } from '../../app/admin-shell.js';
import { createRegistries } from '../../lib/registries.js';
import { ApiError } from '../../lib/api.js';
import { LeadsWorkspace } from './page.js';
import type { Lead, LeadClient } from './api.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const id = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
function lead(n: number, stage: LeadStage, extra: Partial<Lead> = {}): Lead {
  return { memberId: id(n), householdId: id(100 + n), firstName: 'Lead', lastName: 'No' + n, email: null, phone: null, status: 'prospect',
    source: 'trial_form', stage, nextFollowUpOn: null, lastContactedAt: null, createdAt: '2026-11-01T12:00:00.000Z', revision: n, ...extra };
}
const session: ClassSession = { id: id(900), name: 'Fundamentals', startsAt: new Date(Date.now() + 3_600_000).toISOString(), capacity: 20 } as ClassSession;
const started: ClassSession = { id: id(901), name: 'Open mat', startsAt: new Date(Date.now() - 60_000).toISOString(), capacity: 20 } as ClassSession;
function fixture(leads: Lead[]) {
  const client = {
    list: vi.fn(async (query: { stage?: LeadStage | LeadStage[]; source?: string; due?: boolean }) => {
      const rows = leads.filter(row => row.stage === query.stage && (!query.source || (row.source ?? 'unknown') === query.source));
      return { data: rows, pagination: { limit: 25, offset: 0, total: rows.length }, counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    }),
    edit: vi.fn(async (row: Lead, patch: Partial<Lead> = {}) => ({ ...row, ...patch })),
    lost: vi.fn(async (row: Lead) => ({ ...row, stage: 'lost' as const })), reopen: vi.fn(async (row: Lead) => ({ ...row, stage: 'contacted' as const })),
    sessions: vi.fn(async () => [started, session]), book: vi.fn(async () => ({})),
  };
  return client as unknown as LeadClient & typeof client;
}
const sample = () => [lead(1, 'new'), lead(2, 'new', { source: 'walk_in' }), lead(3, 'contacted', { nextFollowUpOn: '2026-11-15' }),
  lead(4, 'trial_booked'), lead(5, 'trial_attended'), lead(6, 'lost', { source: null })];
function mount(client: LeadClient, roles: readonly StaffRole[] = ['owner']) {
  return render(<LeadsWorkspace timezone="America/New_York" roles={roles} client={client} />);
}
const column = (name: string) => screen.getByRole('region', { name });
const card = (name: string) => screen.getByRole('heading', { name }).closest('article') as HTMLElement;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('leads board', () => {
  it('includes every visible action label in its accessible name, including lost leads', async () => {
    const client = fixture(sample()); const { container } = mount(client);
    await screen.findByText('Lead No1');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show lost' }));
    await screen.findByText('Lead No6');
    const actions = container.querySelectorAll('article button[aria-label], article a[aria-label]');
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action.getAttribute('aria-label')!.toLowerCase())
      .toContain(action.textContent!.trim().toLowerCase());
  });
  it('refreshes only the old and new columns, keeps loaded pages and focuses the outcome', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => lead(index + 1, 'new'));
    const client = fixture(rows);
    client.list.mockImplementation(async (query: { stage?: LeadStage | LeadStage[]; limit?: number; offset?: number }) => {
      const matches = rows.filter(row => row.stage === query.stage), limit = query.limit ?? 25, offset = query.offset ?? 0;
      return { data: matches.slice(offset, offset + limit), pagination: { limit, offset, total: matches.length },
        counts: { new: matches.length, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    });
    client.edit.mockImplementation(async (row, patch) => {
      const updated = { ...row, ...patch, revision: row.revision + 1 };
      rows.splice(rows.findIndex(item => item.memberId === row.memberId), 1, updated); return updated;
    });
    mount(client); await screen.findByText('Lead No1');
    await userEvent.click(within(column('New')).getByRole('button', { name: 'Show more' }));
    await screen.findByText('Lead No30'); client.list.mockClear();
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    await waitFor(() => expect(within(column('Contacted')).getByText('Lead No1')).toBeDefined());
    expect(within(column('New')).getByText('Lead No30')).toBeDefined();
    expect(client.list.mock.calls.map(([query]) => query.stage).sort()).toEqual(['contacted', 'new', 'new']);
    expect(document.activeElement?.textContent).toBe('Lead saved.');
  });
  it('shows a lead once when rows move between the pages of a column reload', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => lead(index + 1, 'new'));
    const client = fixture(rows);
    let shift = 0;
    client.list.mockImplementation(async (query: { stage?: LeadStage | LeadStage[]; limit?: number; offset?: number }) => {
      const matches = rows.filter(row => row.stage === query.stage), limit = query.limit ?? 25;
      const offset = Math.max(0, (query.offset ?? 0) - (query.offset ? shift : 0));
      return { data: matches.slice(offset, offset + limit), pagination: { limit, offset: query.offset ?? 0, total: matches.length },
        counts: { new: matches.length, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    });
    mount(client); await screen.findByText('Lead No1');
    await userEvent.click(within(column('New')).getByRole('button', { name: 'Show more' }));
    await screen.findByText('Lead No30');
    client.edit.mockImplementation(async (row, patch) => {
      const updated = { ...row, ...patch, revision: row.revision + 1 };
      rows.splice(rows.findIndex(item => item.memberId === row.memberId), 1, updated); return updated;
    });
    // The second page starts one row early, as if a lead joined the column between the two requests.
    shift = 1;
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    await waitFor(() => expect(within(column('Contacted')).getByText('Lead No1')).toBeDefined());
    await waitFor(() => expect(within(column('New')).queryByText('Lead No1')).toBeNull());
    expect(within(column('New')).getAllByText('Lead No26')).toHaveLength(1);
    expect(within(column('New')).getAllByRole('article')).toHaveLength(29);
  });
  it('clears rows when a reload fails so stale revisions cannot be edited', async () => {
    const client = fixture(sample()); mount(client); await screen.findByText('Lead No1');
    client.list.mockRejectedValue(new ApiError(500, 'request_failed'));
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    await within(column('New')).findByRole('alert');
    expect(screen.queryByText('Lead No1')).toBeNull(); expect(screen.queryByText('Lead No2')).toBeNull();
    expect(screen.getByText('Lead No4')).toBeDefined();
  });
  it('shows a column per open stage with its total, and keeps lost leads hidden until the toggle', async () => {
    const client = fixture(sample()); mount(client);
    expect(await screen.findByRole('heading', { name: 'New (2)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Contacted (1)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Trial booked (1)' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Trial attended (1)' })).toBeDefined();
    expect(screen.queryByText('Lead No6')).toBeNull();
    expect(client.list.mock.calls.some(([query]) => query.stage === 'lost')).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show lost' }));
    expect(await screen.findByText('Lead No6')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Lost (1)' })).toBeDefined();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show lost' }));
    await waitFor(() => expect(screen.queryByText('Lead No6')).toBeNull());
  });

  it('shows each lead with its source, member status and next follow-up', async () => {
    mount(fixture(sample()));
    const row = card(await screen.findByText('Lead No3').then(() => 'Lead No3'));
    expect(within(row).getByText('Trial form · Prospect')).toBeDefined();
    expect(within(row).getByText('Follow-up on 2026-11-15')).toBeDefined();
    expect(within(card('Lead No1')).getByText('No follow-up set')).toBeDefined();
  });

  it('sends the source and follow-up due filters to every column', async () => {
    const client = fixture(sample()); mount(client);
    await screen.findByText('Lead No1');
    client.list.mockClear();
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'walk_in');
    await waitFor(() => expect(screen.queryByText('Lead No1')).toBeNull());
    expect(screen.getByText('Lead No2')).toBeDefined();
    expect(client.list.mock.calls.map(([query]) => query)).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'new', source: 'walk_in' })]));
    client.list.mockClear();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Follow-up due' }));
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(client.list.mock.calls.every(([query]) => query.due === true && query.source === 'walk_in')).toBe(true);
  });

  it('changes the stage and the follow-up date with the lead revision, then reloads', async () => {
    const client = fixture(sample()); mount(client);
    await screen.findByText('Lead No1');
    client.list.mockClear();
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    await waitFor(() => expect(client.edit).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(1), revision: 1 }), { stage: 'contacted' }));
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(await screen.findByText('Lead saved.')).toBeDefined();
    client.edit.mockClear();
    const followUp = within(card('Lead No1')).getByLabelText('Next follow-up for Lead No1');
    fireEvent.change(followUp, { target: { value: '0002-12-01' } });
    fireEvent.change(followUp, { target: { value: '2026-12-01' } });
    await tick();
    expect(client.edit).not.toHaveBeenCalled();
    fireEvent.blur(followUp);
    await waitFor(() => expect(client.edit).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(1) }), { nextFollowUpOn: '2026-12-01' }));
    expect(client.edit).toHaveBeenCalledOnce();
    // Stage changes refresh two columns, and a date edit refreshes its current column.
    await waitFor(() => expect(client.list.mock.calls.length).toBeGreaterThanOrEqual(3));
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1));
    const cleared = within(card('Lead No3')).getByLabelText('Next follow-up for Lead No3');
    fireEvent.change(cleared, { target: { value: '' } });
    fireEvent.blur(cleared);
    await waitFor(() => expect(client.edit).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(3) }), { nextFollowUpOn: null }));
  });

  it('keeps the saved follow-up when a date is left partly typed, and saves nothing unchanged', async () => {
    const client = fixture(sample()); mount(client);
    await screen.findByText('Lead No3');
    const input = within(card('Lead No3')).getByLabelText('Next follow-up for Lead No3') as HTMLInputElement;
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '' } });
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.blur(input);
    await tick();
    expect(client.edit).not.toHaveBeenCalled();
    expect(input.value).toBe('2026-11-15');
  });

  it('says the lead changed and reloads after a 409', async () => {
    const client = fixture(sample()); client.edit.mockRejectedValueOnce(new ApiError(409, 'conflict')); mount(client);
    await screen.findByText('Lead No1');
    client.list.mockClear();
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    expect((await screen.findByRole('alert')).textContent).toContain('This lead changed');
    await waitFor(() => expect(client.list).toHaveBeenCalled());
  });

  it('shows a plain error and does not reload when a write fails otherwise', async () => {
    const client = fixture(sample()); client.edit.mockRejectedValueOnce(new ApiError(500, 'request_failed')); mount(client);
    await screen.findByText('Lead No1');
    client.list.mockClear();
    await userEvent.selectOptions(within(card('Lead No1')).getByLabelText('Stage for Lead No1'), 'contacted');
    expect((await screen.findByRole('alert')).textContent).toContain('could not save');
    await tick();
    expect(client.list).not.toHaveBeenCalled();
  });

  it('drops a "Show more" page that returns after the filter changed', async () => {
    const client = fixture(sample()); let finish: (value: unknown) => void = () => {};
    client.list.mockImplementation(async (query: { stage?: LeadStage | LeadStage[]; source?: string; offset?: number }) => {
      if (query.offset) return new Promise<never>(resolve => { finish = resolve as (value: unknown) => void; });
      const rows = sample().filter(row => row.stage === query.stage && (!query.source || row.source === query.source));
      return { data: rows, pagination: { limit: 25, offset: 0, total: query.stage === 'new' ? 30 : rows.length }, counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    });
    mount(client);
    await screen.findByText('Lead No1');
    await userEvent.click(within(column('New')).getByRole('button', { name: 'Show more' }));
    await userEvent.selectOptions(screen.getByLabelText('Source'), 'walk_in');
    await waitFor(() => expect(screen.queryByText('Lead No1')).toBeNull());
    finish({ data: [lead(7, 'new')], pagination: { limit: 25, offset: 2, total: 30 }, counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } });
    await tick();
    expect(screen.queryByText('Lead No7')).toBeNull();
    expect(screen.getByText('Lead No2')).toBeDefined();
  });

  it('links convert to the membership tab of the member profile', async () => {
    mount(fixture(sample()));
    await screen.findByText('Lead No1');
    expect(within(card('Lead No1')).getByRole('link', { name: 'Convert to member: Lead No1' }).getAttribute('href')).toBe(`/admin/members/${id(1)}#memberTabs.membership`);
  });
});

describe('book a trial class', () => {
  it.each([
    ['full', 'This class is full. Choose another class.'],
    ['alreadyBooked', 'This lead already has a booking for this class.'],
    ['sessionClosed', 'This class has started or was cancelled. Choose another class.'],
    ['windowClosed', 'Bookings for this class are not open yet.'],
    ['noReservation', 'This class does not take bookings.'],
  ])('explains the booking conflict %s and leaves the lead stage alone', async (reason, message) => {
    const client = fixture(sample()); client.book.mockRejectedValueOnce(new ApiError(409, 'conflict', [reason]));
    const dialog = await openBooking(client);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect(await within(dialog).findByText(message)).toBeDefined(); expect(client.edit).not.toHaveBeenCalled();
  });
  async function openBooking(client: LeadClient, name = 'Lead No1') {
    mount(client); await screen.findByText(name);
    await userEvent.click(within(card(name)).getByRole('button', { name: `Book a trial class for ${name}` }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: /Fundamentals/ });
    expect(within(dialog).queryByRole('option', { name: /Open mat/ })).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('Upcoming class'), session.id);
    return dialog;
  }
  it('books through the staff booking, then moves a new lead to trial booked with its revision', async () => {
    const client = fixture(sample()); const dialog = await openBooking(client);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    await waitFor(() => expect(client.edit).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(1), revision: 1 }), { stage: 'trial_booked' }));
    expect(client.book).toHaveBeenCalledWith({ memberId: id(1), sessionId: session.id, allowWaitlist: false });
    expect(client.book.mock.invocationCallOrder[0]!).toBeLessThan(client.edit.mock.invocationCallOrder[0]!);
    expect(await screen.findByText('Trial class booked.')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('leaves the stage alone when the booking fails', async () => {
    const client = fixture(sample()); client.book.mockRejectedValueOnce(new ApiError(409, 'booking_request_failed'));
    const dialog = await openBooking(client);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('The lead stage has not changed');
    expect(client.edit).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
  });
  it('does not change the stage of a lead that already attended or booked', async () => {
    const client = fixture(sample()); const dialog = await openBooking(client, 'Lead No5');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect(await screen.findByText('Trial class booked.')).toBeDefined();
    expect(client.book).toHaveBeenCalledOnce();
    expect(client.edit).not.toHaveBeenCalled();
  });
  it('reports a booked class whose stage could not be set, and one whose lead changed', async () => {
    const client = fixture(sample()); client.edit.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    let dialog = await openBooking(client);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The class is booked, but we could not update the lead stage');
    cleanup();
    const changed = fixture(sample()); changed.edit.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    dialog = await openBooking(changed);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This lead changed');
  });
  it('cannot be closed while the booking is being saved', async () => {
    const client = fixture(sample()); let finish: (value: object) => void = () => {};
    client.book.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const dialog = await openBooking(client);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Book a trial class' }));
    expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
    finish({});
    expect(await screen.findByText('Trial class booked.')).toBeDefined();
  });
  it('says when no class can be booked on the chosen date', async () => {
    const client = fixture(sample()); client.sessions.mockResolvedValue([]); mount(client);
    await screen.findByText('Lead No1');
    await userEvent.click(within(card('Lead No1')).getByRole('button', { name: 'Book a trial class for Lead No1' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('No upcoming bookable classes on this date.')).toBeDefined();
    expect((within(dialog).getByRole('button', { name: 'Book a trial class' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('mark lost and reopen', () => {
  it('counts a lost reason in code points and allows 500 emoji', async () => {
    const client = fixture(sample()); mount(client); await screen.findByText('Lead No2');
    await userEvent.click(within(card('Lead No2')).getByRole('button', { name: 'Mark lost: Lead No2' }));
    const dialog = await screen.findByRole('dialog'), reason = within(dialog).getByLabelText('Reason');
    expect(reason.hasAttribute('maxlength')).toBe(false);
    fireEvent.change(reason, { target: { value: '\u{1F600}'.repeat(501) } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    expect(await within(dialog).findByText('Enter a reason of at most 500 characters.')).toBeDefined();
    expect(client.lost).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: '  ' + '\u{1F600}'.repeat(500) + '  ' } });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    await waitFor(() => expect(client.lost).toHaveBeenCalledWith(expect.anything(), '\u{1F600}'.repeat(500)));
  });
  it('requires a reason and sends it with the revision', async () => {
    const client = fixture(sample()); mount(client);
    await screen.findByText('Lead No2');
    await userEvent.click(within(card('Lead No2')).getByRole('button', { name: 'Mark lost: Lead No2' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Mark lost' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Reason'), '   ');
    expect(submit.disabled).toBe(true);
    await userEvent.type(within(dialog).getByLabelText('Reason'), ' Moved away ');
    await userEvent.click(submit);
    await waitFor(() => expect(client.lost).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(2), revision: 2 }), 'Moved away'));
    expect(await screen.findByText('Lead marked lost.')).toBeDefined();
  });
  it('keeps the dialog open on an error and reloads on a 409', async () => {
    const client = fixture(sample()); client.lost.mockRejectedValueOnce(new ApiError(500, 'request_failed')); mount(client);
    await screen.findByText('Lead No2');
    await userEvent.click(within(card('Lead No2')).getByRole('button', { name: 'Mark lost: Lead No2' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'No answer');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('could not save');
    client.lost.mockRejectedValueOnce(new ApiError(409, 'conflict')); client.list.mockClear();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Mark lost' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('This lead changed');
    await waitFor(() => expect(client.list).toHaveBeenCalled());
  });
  it('reopens a lost lead with its revision, and a 409 reloads', async () => {
    const client = fixture(sample()); mount(client);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show lost' }));
    await screen.findByText('Lead No6');
    const lost = card('Lead No6');
    expect(within(lost).queryByRole('button', { name: /Mark/ })).toBeNull();
    expect(within(lost).getByText('Not recorded · Prospect')).toBeDefined();
    await userEvent.click(within(lost).getByRole('button', { name: 'Reopen lead: Lead No6' }));
    await waitFor(() => expect(client.reopen).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(6), revision: 6 })));
    expect(await screen.findByText('Lead reopened as contacted.')).toBeDefined();
    client.reopen.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    await userEvent.click(within(card('Lead No6')).getByRole('button', { name: 'Reopen lead: Lead No6' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This lead changed');
  });
});

describe('access', () => {
  it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('gates the registered Leads navigation for %s', role => {
    const navigation = visibleAdminNavigation(createRegistries().adminNav.all(), { userId: id(1), displayName: 'Staff', roles: [role], member: false }, []);
    expect(navigation.some(entry => entry.href === '/admin/leads')).toBe(role !== 'coach');
  });
  it.each([['coach'], []] as StaffRole[][])('refuses direct access for roles %s before loading any lead', async (...roles) => {
    const client = fixture(sample()); mount(client, roles);
    expect(screen.getByText('You do not have access to leads.')).toBeDefined();
    await tick();
    expect(client.list).not.toHaveBeenCalled();
  });
  it('shows a stage that fails to load without hiding the others', async () => {
    const client = fixture(sample());
    client.list.mockImplementation(async (query: { stage?: LeadStage | LeadStage[] }) => {
      if (query.stage === 'contacted') throw new ApiError(500, 'request_failed');
      const rows = sample().filter(row => row.stage === query.stage);
      return { data: rows, pagination: { limit: 25, offset: 0, total: rows.length }, counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    });
    mount(client);
    expect(await within(column('Contacted')).findByRole('alert')).toBeDefined();
    expect(await screen.findByText('Lead No1')).toBeDefined();
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LeadContact, LeadStage } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';
import { ApiError } from '../../lib/api.js';
import { LeadWorkspace } from './lead.js';
import { LeadsWorkspace } from './page.js';
import type { Lead, LeadClient } from './api.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const id = (n: number) => `0194a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
type Detail = Lead & { lostReason: string | null };
function lead(stage: LeadStage = 'new', extra: Partial<Detail> = {}): Detail {
  return { memberId: id(1), householdId: id(101), firstName: 'Lena', lastName: 'Lead', email: 'lena@example.test', phone: '+1 555 0100',
    status: 'prospect', source: 'walk_in', stage, nextFollowUpOn: '2026-11-12', lastContactedAt: null, createdAt: '2026-11-01T12:00:00.000Z',
    revision: 3, lostReason: null, ...extra };
}
function contact(n: number, extra: Partial<LeadContact> = {}): LeadContact {
  return { id: id(200 + n), occurredAt: `2026-11-0${n}T15:00:00.000Z`, channel: 'call', note: 'Note ' + n, createdBy: id(300),
    createdByName: 'Dana Desk', ...extra };
}
function fixture(current: Detail = lead(), contacts: LeadContact[] = [contact(3), contact(2)]) {
  const state = { lead: current, contacts };
  const client = {
    read: vi.fn(async () => state.lead),
    contacts: vi.fn(async (_memberId: string, query: { limit?: number; offset?: number }) => {
      const offset = query.offset ?? 0, limit = query.limit ?? 50;
      return { data: state.contacts.slice(offset, offset + limit), pagination: { limit, offset, total: state.contacts.length } };
    }),
    logContact: vi.fn(async (row: Lead, input: { channel: LeadContact['channel']; note?: string; nextFollowUpOn?: string | null }) => {
      const logged = contact(9, { occurredAt: '2026-11-09T15:00:00.000Z', channel: input.channel, note: input.note ?? null });
      state.contacts = [logged, ...state.contacts];
      state.lead = { ...state.lead, stage: row.stage === 'new' ? 'contacted' : row.stage, revision: row.revision + 1,
        nextFollowUpOn: input.nextFollowUpOn === undefined ? row.nextFollowUpOn : input.nextFollowUpOn, lastContactedAt: logged.occurredAt };
      return { lead: state.lead, contact: logged };
    }),
    list: vi.fn(async (query: { stage?: LeadStage | LeadStage[] }) => {
      const rows = state.lead.stage === query.stage ? [state.lead] : [];
      return { data: rows, pagination: { limit: 25, offset: 0, total: rows.length }, counts: { new: 0, contacted: 0, trial_booked: 0, trial_attended: 0, won: 0, lost: 0 } };
    }),
    edit: vi.fn(async (row: Lead) => row), lost: vi.fn(async (row: Lead) => row), reopen: vi.fn(async (row: Lead) => row),
    sessions: vi.fn(async () => []), book: vi.fn(async () => ({})),
  };
  return client as unknown as LeadClient & typeof client;
}
function mount(client: LeadClient, roles: readonly StaffRole[] = ['front_desk']) {
  return render(<LeadWorkspace memberId={id(1)} timezone="America/New_York" roles={roles} client={client} />);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const stage = () => screen.getByRole('heading', { level: 1 }).parentElement?.querySelector('p')?.textContent;
const form = () => screen.getByRole('form', { name: 'Log a contact with Lena Lead' });

describe('lead page', () => {
  it('shows the lead\'s details, its quick actions and the contact log newest first, times in the gym\'s zone', async () => {
    const client = fixture(lead('lost', { lostReason: 'Moved away', lastContactedAt: '2026-11-03T15:00:00.000Z' })); mount(client);
    expect(await screen.findByRole('heading', { level: 1, name: 'Lena Lead' })).toBeDefined();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByRole('link', { name: 'lena@example.test' }).getAttribute('href')).toBe('mailto:lena@example.test');
    expect(within(details).getByText('Walk-in')).toBeDefined();
    expect(within(details).getByText('Moved away')).toBeDefined();
    expect(within(details).getByText('Nov 3, 2026, 10:00 AM')).toBeDefined();
    expect(within(screen.getByRole('region', { name: 'Quick actions' })).getByRole('button', { name: 'Reopen Lena Lead' })).toBeDefined();
    const log = await screen.findAllByRole('listitem');
    expect(log.map(item => within(item).getByText(/^Note /).textContent)).toEqual(['Note 3', 'Note 2']);
    expect(within(log[0]!).getByText('Logged by Dana Desk')).toBeDefined();
    expect(client.contacts).toHaveBeenCalledWith(id(1), { limit: 20, offset: 0 }, expect.any(AbortSignal));
  });
  it('logs a contact with its channel, trimmed note and follow-up, then shows the new stage and reloads the log', async () => {
    const client = fixture(); mount(client);
    await screen.findByRole('heading', { level: 1, name: 'Lena Lead' });
    expect(stage()).toBe('New');
    await userEvent.selectOptions(within(form()).getByLabelText('How you reached them'), 'in_person');
    await userEvent.type(within(form()).getByLabelText('Note (optional)'), '  Came by after class  ');
    await userEvent.type(within(form()).getByLabelText('Next follow-up (optional)'), '2026-11-20');
    await userEvent.click(within(form()).getByRole('button', { name: 'Log contact' }));
    expect(await screen.findByText('Contact logged.')).toBeDefined();
    expect(client.logContact).toHaveBeenCalledWith(expect.objectContaining({ revision: 3 }),
      { channel: 'in_person', note: 'Came by after class', nextFollowUpOn: '2026-11-20' });
    expect(stage()).toBe('Contacted');
    expect(await screen.findByText('Came by after class')).toBeDefined();
    expect((within(form()).getByLabelText('Note (optional)') as HTMLTextAreaElement).value).toBe('');
  });
  it('sends no note or follow-up when they are left empty', async () => {
    const client = fixture(lead('trial_booked')); mount(client);
    await screen.findByRole('heading', { level: 1, name: 'Lena Lead' });
    await userEvent.type(within(form()).getByLabelText('Note (optional)'), '   ');
    await userEvent.click(within(form()).getByRole('button', { name: 'Log contact' }));
    await waitFor(() => expect(client.logContact).toHaveBeenCalledWith(expect.anything(), { channel: 'call' }));
    await waitFor(() => expect(stage()).toBe('Trial booked'));
  });
  it('reloads the lead and says it changed when logging conflicts, and keeps the form on any other failure', async () => {
    const client = fixture(); mount(client);
    await screen.findByRole('heading', { level: 1, name: 'Lena Lead' });
    client.logContact.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await userEvent.type(within(form()).getByLabelText('Note (optional)'), 'Kept');
    await userEvent.click(within(form()).getByRole('button', { name: 'Log contact' }));
    expect(await within(form()).findByRole('alert')).toHaveProperty('textContent', 'We could not save this change. Try again.');
    expect((within(form()).getByLabelText('Note (optional)') as HTMLTextAreaElement).value).toBe('Kept');
    client.logContact.mockRejectedValueOnce(new ApiError(409, 'conflict'));
    client.read.mockClear();
    await userEvent.click(within(form()).getByRole('button', { name: 'Log contact' }));
    expect(await screen.findByText(/This lead changed/)).toBeDefined();
    await waitFor(() => expect(client.read).toHaveBeenCalled());
  });
  it('pages the contact log with Show more', async () => {
    const many = Array.from({ length: 25 }, (_, n) => contact(1, { id: id(400 + n), note: 'Entry ' + n }));
    const client = fixture(lead(), many); mount(client);
    expect(await screen.findByText('Entry 19')).toBeDefined();
    expect(screen.queryByText('Entry 20')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText('Entry 24')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });
  it('says when the lead is not found, and refuses coaches before loading anything', async () => {
    const missing = fixture(); missing.read.mockRejectedValue(new ApiError(404, 'request_failed')); mount(missing);
    expect(await screen.findByText(/This lead was not found/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'All leads' }).getAttribute('href')).toBe('/admin/leads');
    cleanup();
    const malformed = fixture(); malformed.read.mockRejectedValue(new ApiError(400, 'invalid_request')); mount(malformed);
    expect(await screen.findByText(/This lead was not found/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    cleanup();
    const client = fixture(); mount(client, ['coach']);
    expect(screen.getByText('You do not have access to leads.')).toBeDefined();
    await tick();
    expect(client.read).not.toHaveBeenCalled(); expect(client.contacts).not.toHaveBeenCalled();
  });
  it('keeps a won lead\'s stage: no stage select, booking or loss, but the follow-up and the log stay open', async () => {
    mount(fixture(lead('won', { status: 'active' })));
    await screen.findByRole('heading', { level: 1, name: 'Lena Lead' });
    const actions = screen.getByRole('region', { name: 'Quick actions' });
    expect(within(actions).queryByRole('combobox')).toBeNull();
    expect(within(actions).queryByRole('button', { name: 'Mark Lena Lead lost' })).toBeNull();
    expect(within(actions).getByLabelText('Next follow-up for Lena Lead')).toBeDefined();
    expect(form()).toBeDefined();
  });
});

describe('log-a-contact action on the leads list', () => {
  it('opens the lead page from the name and logs a contact from a dialog, then reloads the columns', async () => {
    const client = fixture();
    render(<LeadsWorkspace timezone="America/New_York" roles={['front_desk']} client={client} />);
    const link = await screen.findByRole('link', { name: 'Lena Lead' });
    expect(link.getAttribute('href')).toBe('/admin/leads/' + id(1));
    await userEvent.click(screen.getByRole('button', { name: 'Log a contact with Lena Lead' }));
    const dialog = await screen.findByRole('dialog', { name: 'Log a contact with Lena Lead' });
    await userEvent.selectOptions(within(dialog).getByLabelText('How you reached them'), 'text');
    client.list.mockClear();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Log contact' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(client.logContact).toHaveBeenCalledWith(expect.objectContaining({ memberId: id(1), revision: 3 }), { channel: 'text' });
    expect(await screen.findByText('Contact logged.')).toBeDefined();
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(await within(screen.getByRole('region', { name: 'Contacted' })).findByRole('link', { name: 'Lena Lead' })).toBeDefined();
  });
});

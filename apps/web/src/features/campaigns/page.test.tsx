// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Household, LinkCampaignDetail } from '@plaingym/shared/contracts';
import { CampaignWorkspace } from './page.js';
import { CampaignEditor } from './editor.js';
import type { CampaignClient } from './api.js';
import { registration } from './registrations.js';
import { ApiError } from '../../lib/api.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const id = '01900000-0000-7000-8000-000000000001', householdId = '01900000-0000-7000-8000-000000000002';
const detail: LinkCampaignDetail = { campaign: { id, name: 'October welcome', purpose: 'onboarding', createdBy: null,
  reminderSchedule: [3, 7], completedAt: null, createdAt: '2026-10-26T12:00:00Z' },
  progress: { total: 1, pending: 1, completed: 0, expired: 0, revoked: 0 } };
const household: Household = { id: householdId, name: 'Chen household', email: 'payer@example.test', phone: null, address: {}, revision: 1, createdAt: '2026-10-26T12:00:00Z' };
function client(): CampaignClient {
  return {
    needsCard: vi.fn(async () => [householdId]),
    list: vi.fn(async () => ({ data: [detail], pagination: { total: 1, limit: 20, offset: 0 } })),
    get: vi.fn(async () => detail),
    recipients: vi.fn(async () => ({ data: [{ state: 'pending' as const, link: { id, householdId, campaignId: id, purpose: 'onboarding' as const,
      invoiceId: null, memberId: null, usedAt: null, revokedAt: null, createdBy: null, createdAt: '2026-10-26T12:00:00Z', expiresAt: '2026-11-26T12:00:00Z' } }],
      pagination: { total: 1, limit: 20, offset: 0 } })),
    create: vi.fn(async () => detail), remind: vi.fn(async () => ({ queued: 1 })), households: vi.fn(async () => [household]),
  };
}
function mount(service: CampaignClient) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={cache}><CampaignWorkspace gymId={id} timezone="America/Los_Angeles" client={service} /></QueryClientProvider>);
}
describe('campaign admin screens', () => {
  it('validates the 90-day expiry using the gym-local end of day and maps server invalid requests to limits', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-10-26T12:00:00Z').getTime());
    const save = vi.fn(async () => { throw new ApiError(400, 'invalid_request'); }), user = userEvent.setup();
    render(<CampaignEditor households={[household]} timezone="America/Los_Angeles" save={save} close={() => {}} />);
    await user.type(screen.getByLabelText('Campaign name'), 'Cards'); await user.click(screen.getByRole('checkbox', { name: /Chen/ }));
    // Jan 24 is within 90 calendar dates, but its local end is beyond the exact 90-day limit.
    fireEvent.change(screen.getByLabelText('Links expire'), { target: { value: '2027-01-24' } });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect(screen.getByRole('alert').textContent).toContain('expiry within 90 days'); expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Links expire'), { target: { value: '2027-01-23' } });
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: '2027-01-24T07:59:59.000Z' }));
    expect(screen.getByRole('alert').textContent).toContain('Check the campaign limits');
    expect(screen.getByRole('alert').textContent).not.toContain('Refresh the campaign list');
  });
  it.each([
    ['Campaign name', 'x'.repeat(121), '120 characters'],
    ['Reminder days', '1,2,3,4,5,6,7,8,9,10,11', '10 reminder days'],
    ['Reminder days', '366', '365 or less'],
  ])('gives a specific limit message for %s', async (field, value, expected) => {
    const save = vi.fn(async () => {}), user = userEvent.setup();
    render(<CampaignEditor households={[household]} timezone="UTC" save={save} close={() => {}} />);
    fireEvent.change(screen.getByLabelText('Campaign name'), { target: { value: 'Cards' } });
    fireEvent.change(screen.getByLabelText('Links expire'), { target: { value: '2026-11-26' } });
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    await user.click(screen.getByRole('checkbox', { name: /Chen/ })); await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect(screen.getByRole('alert').textContent).toContain(expected); expect(save).not.toHaveBeenCalled();
  });
  it('enables navigation only for staff who can send links', () => {
    expect(registration.adminNav?.[0]).toMatchObject({ enabled: true, href: '/admin/campaigns', permission: { kind: 'staff', capability: 'links.send' } });
  });
  it('shows progress, defaults to who is left, filters recipients and queues reminders', async () => {
    const service = client(), user = userEvent.setup(); mount(service);
    await user.click(await screen.findByRole('button', { name: 'View October welcome' }));
    expect(await screen.findByText('Chen household')).toBeDefined();
    expect(service.recipients).toHaveBeenCalledWith(id, 'pending', 0);
    await user.selectOptions(screen.getByLabelText("Who's left?"), 'completed');
    expect(service.recipients).toHaveBeenCalledWith(id, 'completed', 0);
    await user.click(screen.getByRole('button', { name: 'Remind pending households' }));
    expect(service.remind).toHaveBeenCalledWith(id);
    expect((await screen.findByRole('status')).textContent).toContain('Pending recipients queued: 1');
  });
  it('creates a card campaign with timezone-correct expiry and validates reminder days before sending', async () => {
    const service = client(), user = userEvent.setup(); mount(service);
    await screen.findByRole('button', { name: 'View October welcome' });
    await user.click(screen.getByRole('button', { name: 'New campaign' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Campaign name'), 'New cards');
    await user.selectOptions(dialog.getByLabelText('Purpose'), 'update_card');
    await user.type(dialog.getByLabelText('Links expire'), '2026-11-26');
    await user.click(dialog.getByRole('checkbox', { name: /Chen household/ }));
    await user.clear(dialog.getByLabelText('Reminder days')); await user.type(dialog.getByLabelText('Reminder days'), '7, 3');
    await user.click(dialog.getByRole('button', { name: 'Create and send' }));
    expect((await dialog.findByRole('alert')).textContent).toContain('increasing positive');
    expect(service.create).not.toHaveBeenCalled();
    await user.clear(dialog.getByLabelText('Reminder days'));
    await user.click(dialog.getByRole('button', { name: 'Create and send' }));
    expect(service.create).toHaveBeenCalledWith({ name: 'New cards', purpose: 'update_card', reminderSchedule: [],
      expiresAt: '2026-11-27T07:59:59.000Z', recipients: [{ householdId }] });
  });
  it('shows empty, loading and safe retry states and paginates campaigns', async () => {
    const service = client(); vi.mocked(service.list).mockRejectedValueOnce(new Error('private database detail'));
    const user = userEvent.setup(); mount(service);
    expect(screen.getByRole('status')).toBeDefined();
    const error = await screen.findByRole('alert'); expect(error.textContent).not.toContain('private database');
    vi.mocked(service.list).mockResolvedValueOnce({ data: [], pagination: { limit: 20, offset: 0, total: 0 } });
    await user.click(within(error).getByRole('button'));
    expect(await screen.findByText('No campaigns yet')).toBeDefined();
    cleanup();
    vi.mocked(service.list).mockResolvedValue({ data: [detail], pagination: { limit: 20, offset: 0, total: 21 } }); mount(service);
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(service.list).toHaveBeenCalledWith(20);
  });
  it('keeps a failed creation reviewable and disables households with no email', async () => {
    const save = vi.fn(async () => { throw new Error('SQL private'); }), user = userEvent.setup();
    render(<CampaignEditor households={[household, { ...household, id, name: 'No email household', email: null }]} timezone="UTC" save={save} close={() => {}} />);
    expect((screen.getByRole('checkbox', { name: /No email household/ }) as HTMLInputElement).disabled).toBe(true);
    await user.type(screen.getByLabelText('Campaign name'), 'Welcome'); await user.type(screen.getByLabelText('Links expire'), '2026-11-26');
    await user.click(screen.getByRole('button', { name: 'Select matching households' }));
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Refresh the campaign list');
    expect(screen.getByRole('dialog')).toBeDefined(); expect(screen.getByRole('alert').textContent).not.toContain('SQL');
  });
  it('adds matching households across searches and filters households needing a card', async () => {
    const homes = [{ ...household, name: 'Smith' }, { ...household, id, name: 'Jones' }];
    const save = vi.fn(async () => {}), loadNeedsCard = vi.fn(async () => [householdId]), user = userEvent.setup();
    render(<CampaignEditor households={homes} timezone="UTC" save={save} close={() => {}} loadNeedsCard={loadNeedsCard} />);
    await user.type(screen.getByLabelText('Campaign name'), 'New cards'); await user.type(screen.getByLabelText('Links expire'), '2026-11-26');
    const search = screen.getByLabelText('Find households');
    await user.type(search, 'smith'); await user.click(screen.getByRole('button', { name: 'Select matching households' }));
    await user.clear(search); await user.type(search, 'jones'); await user.click(screen.getByRole('button', { name: 'Select matching households' }));
    await user.clear(search);
    await user.click(screen.getByRole('checkbox', { name: 'Needs a card' }));
    expect(await screen.findByRole('checkbox', { name: /Smith/ })).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: /Jones/ })).toBeNull();
    expect(loadNeedsCard).toHaveBeenCalledWith(homes);
    await user.click(screen.getByRole('button', { name: 'Create and send' }));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ recipients: [{ householdId }, { householdId: id }] }));
  });
});

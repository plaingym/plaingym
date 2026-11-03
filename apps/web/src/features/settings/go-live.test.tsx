// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { goLiveChecklistItemSchema, settingsContracts, type GymSettings, type UpdateGoLiveRequest } from '@plaingym/shared/contracts';
import { canStaff, staffRoles } from '@plaingym/shared';
import { GoLiveSettings } from './go-live.js';
import { registration } from './go-live.registrations.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), POST: vi.fn() }));
/** The checklist reads; the shared gym settings read goes through `client.GET` to `settingsReads`. */
const live = vi.hoisted(() => vi.fn());
const settingsReads = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api.js', () => ({ api: client }));
const ids = goLiveChecklistItemSchema.shape.id.options;
const checklist = (revision = 3, billingEnabled = false, memberEmailsEnabled = false) => ({ data: { revision, billingEnabled, memberEmailsEnabled,
  items: ids.map((id) => ({ id, status: id === 'smtp_ready' ? 'needs_attention' : id.startsWith('cards') ? 'not_applicable' : 'ready', message: 'Message for ' + id })) } });
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const overdue = () => ({ ...checklist(), data: { ...checklist().data, pastDueMemberships: [{
  id: '00000000-0000-7000-8000-000000000001', memberId: '00000000-0000-7000-8000-000000000002',
  memberName: 'Ana Silva', planName: 'Monthly classes', revision: 2, nextDueOn: '2026-10-20',
}] } });
const restored = (unresolved: number | null = 2, billingEnabled = false) => ({ data: { ...checklist(3, billingEnabled).data,
  restoreReconciliation: { restoreId: '00000000-0000-7000-8000-000000000003', snapshotAt: '2026-10-20T12:00:00Z',
    checkedAt: unresolved === null ? null : '2026-10-26T12:00:00Z', inspected: unresolved === null ? null : 4, unresolved },
} });
const gymSettings = (revision: number): GymSettings => ({ id: '01900000-0000-7000-8000-000000000001', name: 'Gym', slug: 'gym', timezone: 'America/Vancouver',
  currency: 'CAD', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60,
  openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision,
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' });
const start = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })}><GoLiveSettings/></QueryClientProvider>);
beforeEach(() => {
  live.mockReset(); settingsReads.mockReset(); client.GET.mockReset(); client.PATCH.mockReset(); client.POST.mockReset();
  client.GET.mockImplementation(async (path: string) => path === '/api/settings' ? settingsReads(path) : live(path));
  settingsReads.mockResolvedValue(reply(200, { data: gymSettings(3) })); live.mockResolvedValue(reply(200, checklist()));
});
afterEach(cleanup);
describe('go-live settings', () => {
  it('registers an enabled section for go-live managers', () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ enabled: true,
      permission: { kind: 'staff', capability: 'go_live.manage' }, component: GoLiveSettings });
  });
  it('renders both switches off and every checklist item from the contract', async () => {
    start();
    expect(await screen.findByText('Message for smtp_ready')).toBeDefined();
    expect(live).toHaveBeenCalledWith('/api/settings/go-live');
    for (const id of ids) expect(screen.getByText('Message for ' + id)).toBeDefined();
    expect(screen.getByText('Email delivery').closest('li')!.textContent).toContain('Needs attention');
    expect(screen.getByText('Saved cards').closest('li')!.textContent).toContain('Not applicable');
    const billing = screen.getByRole('button', { name: 'Turn on: Billing' });
    expect(billing.getAttribute('aria-pressed')).toBe('false');
    expect(within(billing.closest('li')!).getByText('Off')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Member emails' })).toBeDefined();
  });
  it('sends the revision with one switch and shows the saved state', async () => {
    client.PATCH.mockResolvedValue(reply(200, checklist(4, false, true)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member emails' }));
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/go-live', { signal: expect.any(AbortSignal), body: { revision: 3, memberEmailsEnabled: true } });
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Billing' })).toBeDefined();
  });
  it('reloads after a conflict and shows safe errors without server details', async () => {
    client.PATCH.mockResolvedValueOnce(reply(409, { error: { message: 'private SQL detail' } }));
    live.mockResolvedValueOnce(reply(200, checklist())).mockResolvedValueOnce(reply(200, checklist(5, true)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect(live).toHaveBeenCalledTimes(2);
    client.PATCH.mockRejectedValueOnce(new Error('Secret network failure'));
    await user.click(screen.getByRole('button', { name: 'Turn off: Billing' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The request failed');
    expect(document.body.textContent).not.toMatch(/private SQL|Secret network/);
  });
  it('offers a retry when loading fails', async () => {
    live.mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200, checklist()));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Message for gym_details')).toBeDefined();
  });
  it('reruns a restored payment check, shows progress and the latest result, and leaves billing paused', async () => {
    live.mockResolvedValue(reply(200, restored()));
    let finish!: (value: unknown) => void;
    client.POST.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup(); start();
    const rerun = await screen.findByRole('button', { name: 'Check restored payments again' });
    expect(screen.getByText(/Objects checked: 4. Unresolved: 2/)).toBeDefined();
    await user.click(rerun);
    expect(client.POST).toHaveBeenCalledWith('/api/settings/go-live/reconciliation', { signal: expect.any(AbortSignal), body: {
      revision: 3, restoreId: restored().data.restoreReconciliation.restoreId,
    } });
    expect(screen.getByText('Checking restored payments…')).toBeDefined();
    expect((rerun as HTMLButtonElement).disabled).toBe(true);
    finish(reply(200, restored(0)));
    expect(await screen.findByText(/Objects checked: 4. Unresolved: 0/)).toBeDefined();
    expect((rerun as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Turn on: Billing' })).toBeDefined();
    expect(client.PATCH).not.toHaveBeenCalled();
  });
  it('allows a rerun when the first check has no result yet', async () => {
    live.mockResolvedValue(reply(200, restored(null))); client.POST.mockResolvedValue(reply(200, restored(0)));
    const user = userEvent.setup(); start();
    expect(await screen.findByText(/No completed result for the latest check/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Check restored payments again' }));
    expect(await screen.findByText(/Unresolved: 0/)).toBeDefined();
  });
  it('shows a safe rerun failure, reloads its persisted result and permits retry', async () => {
    live.mockResolvedValueOnce(reply(200, restored(0))).mockResolvedValue(reply(200, restored(1)));
    client.POST.mockResolvedValueOnce(reply(503, { error: { message: 'secret provider data' } })).mockResolvedValue(reply(200, restored(0)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Check restored payments again' }));
    expect((await screen.findByRole('alert')).textContent).toContain('payment check failed');
    expect(await screen.findByText(/Unresolved: 1/)).toBeDefined();
    expect(document.body.textContent).not.toContain('secret provider data');
    await user.click(screen.getByRole('button', { name: 'Check restored payments again' }));
    expect(await screen.findByText(/Unresolved: 0/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('reloads stale rerun requests and disables rerunning while billing is enabled', async () => {
    live.mockResolvedValueOnce(reply(200, restored())).mockResolvedValue(reply(200, restored(0, true)));
    client.POST.mockResolvedValue(reply(409));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Check restored payments again' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect((screen.getByRole('button', { name: 'Check restored payments again' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Pause billing before checking restored payments.')).toBeDefined();
  });
  it('lists past dates and requires an explicit review before enabling billing', async () => {
    live.mockResolvedValue(reply(200, overdue())); client.PATCH.mockResolvedValue(reply(200, checklist(4, true)));
    const user = userEvent.setup(); start();
    expect(await screen.findByText('Ana Silva')).toBeDefined();
    expect(screen.getByText('Next billing date: 2026-10-20')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    expect(client.PATCH).not.toHaveBeenCalled();
    const enable = within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(enable);
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/go-live', { signal: expect.any(AbortSignal), body: {
      revision: 3, billingEnabled: true, confirmedPastDueDates: [{ id: overdue().data.pastDueMemberships[0]!.id, revision: 2, nextDueOn: '2026-10-20' }],
    } satisfies UpdateGoLiveRequest });
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('cancels without enabling and closes a stale confirmation before reloading changed dates', async () => {
    const latest = overdue(); latest.data.pastDueMemberships[0]!.nextDueOn = '2026-10-21';
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValueOnce(reply(200, latest));
    client.PATCH.mockResolvedValue(reply(409));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(client.PATCH).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Turn on: Billing' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Confirm dates and turn billing on' }));
    expect(await screen.findByText('Next billing date: 2026-10-21')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Turn on: Billing' }));
    expect((screen.getByRole('button', { name: 'Confirm dates and turn billing on' }) as HTMLButtonElement).disabled).toBe(true);
  });
  // Go-live shares the gym revision read by GET /api/settings, though its own routes are registered under another capability.
  it('reads the shared settings under a capability that grants the same roles as its own routes', () => {
    const read = settingsContracts.get.permission.capability;
    for (const route of [settingsContracts.goLiveChecklist, settingsContracts.updateGoLive, settingsContracts.rerunGoLiveReconciliation])
      for (const role of staffRoles) expect(canStaff([role], read), role).toBe(canStaff([role], route.permission.capability));
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { goLiveChecklistItemSchema, settingsContracts, type GymSettings, type UpdateGoLiveRequest } from '@plaingym/shared/contracts';
import { canStaff, staffRoles } from '@plaingym/shared';
import { instantLabel } from '../../lib/instant.js';
import { GoLiveSettings, reconcileTimeoutMs } from './go-live.js';
import { gymSettingsKey, saveTimeoutMs } from './gym-settings.js';
import { holdTimeouts, stalledRequests } from './save-timeout.test-helper.js';
import { registration } from './go-live.registrations.js';
const client = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn(), POST: vi.fn() }));
/** The checklist reads; the shared gym settings read goes through `client.GET` to `settingsReads`. */
const live = vi.hoisted(() => vi.fn());
const settingsReads = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api.js', () => ({ api: client }));
const ids = goLiveChecklistItemSchema.shape.id.options;
const checklist = (revision = 3, billingEnabled = false, memberEmailsEnabled = false) => ({ data: { revision, billingEnabled, memberEmailsEnabled,
  memberSmsEnabled: false,
  items: ids.map((id) => ({ id, status: id === 'smtp_ready' ? 'needs_attention' : id.startsWith('cards') ? 'not_applicable' : 'ready', message: 'Message for ' + id })) } });
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
const overdue = () => ({ ...checklist(), data: { ...checklist().data, pastDueMemberships: [{
  id: '00000000-0000-7000-8000-000000000001', memberId: '00000000-0000-7000-8000-000000000002',
  memberName: 'Ana Silva', planName: 'Monthly classes', revision: 2, nextDueOn: '2026-10-20',
}] } });
const restored = (unresolved: number | null = 2, billingEnabled = false) => ({ data: { ...checklist(3, billingEnabled).data,
  restoreReconciliation: { restoreId: '00000000-0000-7000-8000-000000000003', snapshotAt: '2026-10-20T12:00:00Z',
    checkedAt: unresolved === null ? null : '2026-10-26T12:00:00Z', inspected: unresolved === null ? null : 1200, unresolved },
} });
const gymSettings = (revision: number): GymSettings => ({ id: '01900000-0000-7000-8000-000000000001', name: 'Gym', slug: 'gym', timezone: 'America/Vancouver',
  currency: 'CAD', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60,
  openMatCountsAsClass: false, billingEnabled: false, bankDebitsEnabled: false, memberEmailsEnabled: false, memberSmsEnabled: false, smsDailyCap: 1000, retryDays: [3, 7], dropInChargeTypeId: null, revision,
  createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' });
const start = (clientOverride?: QueryClient) => {
  const queryClient = clientOverride ?? new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  return render(<QueryClientProvider client={queryClient}><GoLiveSettings/></QueryClientProvider>);
};
beforeEach(() => {
  live.mockReset(); settingsReads.mockReset(); client.GET.mockReset(); client.PATCH.mockReset(); client.POST.mockReset();
  client.GET.mockImplementation(async (path: string) => path === '/api/settings' ? settingsReads(path) : live(path));
  settingsReads.mockResolvedValue(reply(200, { data: gymSettings(3) })); live.mockResolvedValue(reply(200, checklist()));
});
afterEach(cleanup);
describe('go-live settings', () => {
  it.each(['test', 'live'] as const)('names the %s-mode restore check when the saved mode differs', async checkedMode => {
    const savedMode = checkedMode === 'test' ? 'live' : 'test', response = restored(0);
    live.mockResolvedValue(reply(200, { data: { ...response.data,
      items: response.data.items.map(item => item.id === 'reconciliation_complete' ? { ...item, status: 'needs_attention', modeChanged: true,
        message: `Resolve pending payment attempts or refunds. The last check read Stripe ${checkedMode} mode. Check restored payments again in ${savedMode} mode before turning billing on.` } : item),
      restoreReconciliation: { ...response.data.restoreReconciliation, stripeConfigured: true, stripeMode: checkedMode } } }));
    start();
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain(`last check read Stripe ${checkedMode} mode`);
    expect(note.textContent).toContain(`again in ${savedMode} mode before turning billing on`);
    expect(note.textContent).toContain('Resolve pending payment attempts or refunds.');
    expect(screen.getByText(/Objects checked: 1,200. Unresolved: 0/)).toBeDefined();
  });
  it('registers an enabled section for go-live managers', () => {
    expect(registration.settingsSections?.[0]).toMatchObject({ enabled: true,
      permission: { kind: 'staff', capability: 'go_live.manage' }, component: GoLiveSettings });
  });
  it('renders all switches off and every checklist item from the contract', async () => {
    start();
    expect(await screen.findByText('Message for smtp_ready')).toBeDefined();
    expect(live).toHaveBeenCalledWith('/api/settings/go-live');
    for (const id of ids) expect(screen.getByText('Message for ' + id)).toBeDefined();
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByText('Email delivery').closest('li')!.textContent).toContain('Needs attention');
    expect(screen.getByText('Saved cards').closest('li')!.textContent).toContain('Not applicable');
    const billing = screen.getByRole('button', { name: 'Turn on: Billing' });
    expect(billing.getAttribute('aria-pressed')).toBe('false');
    expect(within(billing.closest('li')!).getByText('Off')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Member emails' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Member texts' })).toBeDefined();
  });
  it('explains a missing SMS provider instead of reporting a revision change', async () => {
    const user = userEvent.setup(); start();
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 409 }, error: { error: { code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } } } });
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member texts' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Save a working SMS provider');
  });
  it.each([
    { name: 'Member texts', details: { memberSmsEnabled: ['read_failed'] }, message: 'The SMS provider could not be checked. Try turning member texts on again.' },
    { name: 'Billing', details: { billingEnabled: ['read_failed'] }, message: 'Stripe could not be checked. Try turning billing on again.' },
    { name: 'Member texts', details: undefined, message: 'The request failed' },
  ])('shows the right 503 message for $name with details $details', async ({ name, details, message }) => {
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 503 },
      error: { error: { code: 'unavailable', message: 'Private provider detail', details } } });
    const user = userEvent.setup(); start();
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Turn on: ' + name });
    await user.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.queryByText('Private provider detail')).toBeNull();
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect(button.disabled).toBe(false);
  });
  it('shows a save timeout inside the past-due dialog', async () => {
    live.mockResolvedValue(reply(200, overdue()));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    const stalled = stalledRequests(), timers = holdTimeouts(saveTimeoutMs);
    try {
      client.PATCH.mockImplementation(stalled.answer);
      await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      timers.expire(saveTimeoutMs);
      expect((await within(dialog).findByRole('alert')).textContent).toContain('The save took too long to answer');
    } finally { timers.restore(); }
  });
  it.each([
    { name: 'Member texts', details: { memberSmsEnabled: ['read_failed'] }, message: 'The SMS provider could not be checked',
      item: 'sms_ready', reloaded: 'Reloaded SMS readiness' },
    { name: 'Billing', details: { billingEnabled: ['read_failed'] }, message: 'Stripe could not be checked',
      item: 'stripe_ready', reloaded: 'Reloaded payment readiness' },
  ])('reloads the checklist after a $name read failure', async ({ name, details, message, item, reloaded }) => {
    const next = checklist();
    next.data.items = next.data.items.map((entry) => entry.id === item ? { ...entry, message: reloaded } : entry);
    live.mockResolvedValueOnce(reply(200, checklist())).mockResolvedValueOnce(reply(200, next));
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 503 },
      error: { error: { code: 'unavailable', message: 'Private provider detail', details } } });
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: ' + name }));
    expect((await screen.findByRole('alert')).textContent).toContain(message);
    expect(await screen.findByText(reloaded)).toBeDefined();
    expect(live).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Private provider detail');
  });
  it('shows the Stripe read failure on the page and in the past-due confirmation', async () => {
    live.mockResolvedValue(reply(200, overdue()));
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 503 },
      error: { error: { code: 'unavailable', details: { billingEnabled: ['read_failed'] } } } });
    const user = userEvent.setup(); start();
    const billing = await screen.findByRole('button', { name: 'Turn on: Billing' });
    await user.click(billing);
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Confirm dates and turn billing on' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(confirm);
    const message = 'Stripe could not be checked. Try turning billing on again.';
    expect((await within(dialog).findByRole('alert')).textContent).toBe(message);
    expect(screen.getAllByText(message)).toHaveLength(2);
    expect(confirm.disabled).toBe(false);
    expect(billing.getAttribute('aria-pressed')).toBe('false');
  });
  it('shows the restore check time in the gym timezone', async () => {
    const response = restored(0);
    live.mockResolvedValue(reply(200, { data: { ...response.data, restoreReconciliation: {
      ...response.data.restoreReconciliation, checkedAt: '2026-11-21T00:36:58.548Z',
    } } }));
    start();
    const expected = instantLabel('2026-11-21T00:36:58.548Z', 'America/Vancouver');
    const line = await screen.findByText(/Last check:/);
    expect(line.textContent).toContain(expected);
    expect(line.textContent).not.toContain('T00:36');
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
    expect(screen.getByText(/Objects checked: 1,200. Unresolved: 2/)).toBeDefined();
    await user.click(rerun);
    expect(client.POST).toHaveBeenCalledWith('/api/settings/go-live/reconciliation', { signal: expect.any(AbortSignal), body: {
      revision: 3, restoreId: restored().data.restoreReconciliation.restoreId,
    } });
    expect(screen.getByText('Checking restored payments…')).toBeDefined();
    expect((rerun as HTMLButtonElement).disabled).toBe(true);
    finish(reply(200, restored(0)));
    expect(await screen.findByText(/Objects checked: 1,200. Unresolved: 0/)).toBeDefined();
    expect((rerun as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Turn on: Billing' })).toBeDefined();
    expect(client.PATCH).not.toHaveBeenCalled();
  });
  it.each([false, true])('labels the no-Stripe check as stored references and explains the next step (connected: %s)', async connected => {
    const response = restored(0);
    live.mockResolvedValue(reply(200, { data: { ...response.data,
      items: response.data.items.map(item => item.id === 'stripe_ready' ? { ...item, status: connected ? 'ready' : 'needs_attention' } : item),
      restoreReconciliation: { ...response.data.restoreReconciliation, stripeConfigured: false },
    } }));
    start();
    expect(await screen.findByText(/Stored references: 1,200. Unresolved: 0/)).toBeDefined();
    expect(screen.queryByText(/Objects checked:/)).toBeNull();
    expect(screen.getByText(connected ? /last restore check ran without Stripe/ : /last check ran without Stripe and only read restored records/).textContent)
      .toContain('Check restored payments again');
  });
  it('explains an unchecked Stripe read on the no-Stripe restore panel instead of claiming Stripe is disconnected', async () => {
    const response = restored(0);
    live.mockResolvedValue(reply(200, { data: { ...response.data,
      items: response.data.items.map(item => item.id === 'stripe_ready' ? { ...item, status: 'needs_attention',
        message: 'Stripe could not be checked. Check the saved keys in Settings → Integrations → Payments.' } : item),
      restoreReconciliation: { ...response.data.restoreReconciliation, stripeConfigured: false },
    } }));
    start();
    const text = (await screen.findByText(/Stripe could not be checked, so this check can't tell whether Stripe is connected\./)).textContent;
    expect(text).toContain('Check the saved keys in Settings → Integrations → Payments, then choose Check restored payments again.');
    expect(screen.queryByText(/To use Stripe, connect it in Payments/)).toBeNull();
    expect(screen.queryByText(/last restore check ran without Stripe\. Billing is paused/)).toBeNull();
  });
  it('allows a rerun when the first check has no result yet', async () => {
    live.mockResolvedValue(reply(200, restored(null))); client.POST.mockResolvedValue(reply(200, restored(0)));
    const user = userEvent.setup(); start();
    expect(await screen.findByText(/No completed result for the latest check/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Check restored payments again' }));
    expect(await screen.findByText(/Unresolved: 0/)).toBeDefined();
  });
  it('shows unknown restore counts without turning them into zero', async () => {
    const response = restored(null);
    live.mockResolvedValue(reply(200, { data: { ...response.data, restoreReconciliation: {
      ...response.data.restoreReconciliation, checkedAt: '2026-10-26T12:00:00Z',
    } } }));
    start();
    expect(await screen.findByText(/Objects checked: Unknown. Unresolved: Unknown/)).toBeDefined();
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
  it('holds the switches and the rerun while the checklist read after a failed rerun has failed, until it is retried', async () => {
    live.mockResolvedValueOnce(reply(200, restored(0))).mockResolvedValueOnce(reply(500)).mockResolvedValue(reply(200, restored(1)));
    client.POST.mockResolvedValueOnce(reply(503));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Check restored payments again' }));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeDefined();
    expect((screen.getByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Check restored payments again' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Unresolved: 1/)).toBeDefined();
    expect((screen.getByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
  it('waits longer than other saves for the restore check, and says a check it stopped waiting for may still be running', async () => {
    live.mockResolvedValue(reply(200, restored()));
    expect(reconcileTimeoutMs).toBeGreaterThan(saveTimeoutMs);
    const user = userEvent.setup(); start();
    const rerun = await screen.findByRole('button', { name: 'Check restored payments again' });
    const stalled = stalledRequests(), timers = holdTimeouts(saveTimeoutMs, reconcileTimeoutMs);
    try {
      client.POST.mockImplementation(stalled.answer);
      const reads = live.mock.calls.length;
      await user.click(rerun);
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      // The usual timeout would give up on it; only the longer one is set for the check.
      expect(timers.held(saveTimeoutMs)).toBe(0);
      expect(timers.held(reconcileTimeoutMs)).toBe(1);
      timers.expire(reconcileTimeoutMs);
      expect(stalled.signals[0]!.aborted).toBe(true);
      expect((await screen.findByRole('alert')).textContent).toContain('may still be running');
      expect(screen.queryByText(/payment check failed/)).toBeNull();
      await vi.waitFor(() => expect(live.mock.calls.length).toBe(reads + 1));
    } finally { timers.restore(); }
  });
  it('waits for a check already running for the restore instead of reporting a change elsewhere', async () => {
    live.mockResolvedValueOnce(reply(200, restored(null))).mockResolvedValue(reply(200, restored(0)));
    client.POST.mockResolvedValue({ response: { ok: false, status: 409 },
      error: { error: { code: 'conflict', message: 'private', details: { restoreId: ['check_running'] } }, requestId: 'r' } });
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Check restored payments again' }));
    expect((await screen.findByRole('alert')).textContent).toContain('is still running');
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    // The checklist is read again, so the running check's result shows once it has one.
    expect(await screen.findByText(/Unresolved: 0/)).toBeDefined();
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
  it('keeps items and switches on screen during a focus refetch, and prevents an in-flight focus read from overwriting a rerun answer', async () => {
    let resolveFocus!: (value: unknown) => void, resolveRerun!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, restored(2))).mockImplementationOnce(() => new Promise((resolve) => { resolveFocus = resolve; }));
    client.POST.mockImplementationOnce(() => new Promise((resolve) => { resolveRerun = resolve; }));
    const user = userEvent.setup(); start();
    expect(await screen.findByText(/Objects checked: 1,200. Unresolved: 2/)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Check restored payments again' }));
    await vi.waitFor(() => expect(resolveRerun).toBeDefined());
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await vi.waitFor(() => expect(resolveFocus).toBeDefined());
    expect(screen.getByText('Email delivery')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Turn on: Billing' })).toBeDefined();
    await act(async () => { resolveRerun(reply(200, restored(0))); });
    expect(await screen.findByText(/Objects checked: 1,200. Unresolved: 0/)).toBeDefined();
    await act(async () => { resolveFocus(reply(200, restored(2))); });
    expect(screen.getByText(/Objects checked: 1,200. Unresolved: 0/)).toBeDefined();
  });
  it('keeps switches, rerun and the past-due dialog active while a focus refetch is pending', async () => {
    let resolveFocus!: (value: unknown) => void;
    const initial = { data: { ...restored(0).data, pastDueMemberships: overdue().data.pastDueMemberships } };
    live.mockResolvedValueOnce(reply(200, initial)).mockImplementationOnce(() => new Promise((resolve) => { resolveFocus = resolve; }));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await vi.waitFor(() => expect(resolveFocus).toBeDefined());
    expect(screen.queryByText('Saving…')).toBeNull();
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Turn on: Member texts' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Check restored payments again' }) as HTMLButtonElement).disabled).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => { resolveFocus(reply(200, initial)); });
  });
  it('keeps controls enabled without an alert when a focus refetch fails, then adopts the next successful focus read', async () => {
    live.mockResolvedValueOnce(reply(200, restored(2))).mockResolvedValueOnce(reply(500)).mockResolvedValueOnce(reply(200, restored(0)));
    start();
    expect(await screen.findByText(/Objects checked: 1,200. Unresolved: 2/)).toBeDefined();
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Check restored payments again' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Objects checked: 1,200. Unresolved: 2/)).toBeDefined();
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    expect(await screen.findByText(/Objects checked: 1,200. Unresolved: 0/)).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('locks controls with Saving while a 409 follow-up read runs, and shows the refusal text in the read-failure alert if it fails', async () => {
    let resolveReload!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist())).mockImplementationOnce(() => new Promise((resolve) => { resolveReload = resolve; }))
      .mockResolvedValueOnce(reply(200, checklist(4, true)));
    client.PATCH.mockResolvedValueOnce(reply(409));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    await vi.waitFor(() => expect(resolveReload).toBeDefined());
    expect(screen.getByText('Saving…')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolveReload(reply(500)); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('These settings changed elsewhere, so the switch was not changed');
    expect(alert.textContent).toContain('The request failed');
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('marks the reconciliation note by modeChanged rather than message text', async () => {
    const flagged = checklist();
    flagged.data.items = flagged.data.items.map(item => item.id === 'reconciliation_complete'
      ? { ...item, status: 'needs_attention', modeChanged: true, message: 'Custom wording' } : item);
    const unflagged = checklist();
    unflagged.data.items = unflagged.data.items.map(item => item.id === 'reconciliation_complete'
      ? { ...item, status: 'needs_attention', message: 'Resolve pending payment attempts or refunds. The last check read Stripe test mode. Check restored payments again in live mode before turning billing on.' }
      : item);
    live.mockResolvedValueOnce(reply(200, flagged)).mockResolvedValueOnce(reply(200, unflagged));
    start();
    expect((await screen.findByRole('note')).textContent).toBe('Custom wording');
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByText(/last check read Stripe test mode/);
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('clears the past-due confirmation tick when a focus read changes the list, and keeps it when unchanged', async () => {
    const a = { id: '00000000-0000-7000-8000-000000000001', memberId: '00000000-0000-7000-8000-000000000011',
      memberName: 'Ana Silva', planName: 'Monthly classes', revision: 2, nextDueOn: '2026-10-20' };
    const b = { id: '00000000-0000-7000-8000-000000000002', memberId: '00000000-0000-7000-8000-000000000012',
      memberName: 'Bruno Costa', planName: 'Annual classes', revision: 1, nextDueOn: '2026-10-21' };
    const c = { id: '00000000-0000-7000-8000-000000000003', memberId: '00000000-0000-7000-8000-000000000013',
      memberName: 'Carla Dias', planName: 'Monthly classes', revision: 1, nextDueOn: '2026-10-22' };
    const withPastDue = (pastDueMemberships: (typeof a)[], smtpMessage = 'Message for smtp_ready') => ({ data: { ...checklist().data,
      items: checklist().data.items.map(item => item.id === 'smtp_ready' ? { ...item, message: smtpMessage } : item), pastDueMemberships } });
    live.mockResolvedValueOnce(reply(200, withPastDue([a, b])))
      .mockResolvedValueOnce(reply(200, withPastDue([a, b], 'Read again with the same list')))
      .mockResolvedValueOnce(reply(200, withPastDue([a, b, c])));
    client.PATCH.mockResolvedValue(reply(200, checklist(4, true)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    const box = within(dialog).getByRole<HTMLInputElement>('checkbox');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Confirm dates and turn billing on' });
    await user.click(box);
    expect(box.checked).toBe(true);
    expect(confirm.disabled).toBe(false);
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByText('Read again with the same list');
    expect(live).toHaveBeenCalledTimes(2);
    expect(box.checked).toBe(true);
    expect(confirm.disabled).toBe(false);
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await within(dialog).findByText('Carla Dias');
    expect(box.checked).toBe(false);
    expect(confirm.disabled).toBe(true);
    await user.click(box);
    await user.click(confirm);
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/go-live', {
      signal: expect.any(AbortSignal),
      body: {
        revision: 3,
        billingEnabled: true,
        confirmedPastDueDates: [a, b, c].map(({ id, revision, nextDueOn }) => ({ id, revision, nextDueOn })),
      },
    });
  });
  it('unticks the past-due confirmation when a focus read changes one membership revision', async () => {
    const initial = overdue();
    const changed = overdue();
    changed.data.pastDueMemberships[0]!.revision = 3;
    changed.data.items = changed.data.items.map(item => item.id === 'smtp_ready' ? { ...item, message: 'Read again with a new revision' } : item);
    live.mockResolvedValueOnce(reply(200, initial)).mockResolvedValueOnce(reply(200, changed));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    const box = within(dialog).getByRole<HTMLInputElement>('checkbox');
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Confirm dates and turn billing on' });
    await user.click(box);
    expect(box.checked).toBe(true);
    expect(confirm.disabled).toBe(false);
    // Read at each DOM change, so a tick an effect clears only after the changed list has rendered is caught too.
    const changedRenders: { ticked: boolean; disabled: boolean }[] = [];
    const observer = new MutationObserver(() => {
      if (screen.queryByText('Read again with a new revision')) changedRenders.push({ ticked: box.checked, disabled: confirm.disabled });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByText('Read again with a new revision');
    observer.disconnect();
    expect(changedRenders[0]).toEqual({ ticked: false, disabled: true });
    expect(box.checked).toBe(false);
    expect(confirm.disabled).toBe(true);
    expect(client.PATCH).not.toHaveBeenCalled();
  });
  it('closes the past-due dialog when the checklist read after a refused save fails, leaving the page retry reachable', async () => {
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValueOnce(reply(500)).mockResolvedValue(reply(200, overdue()));
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 503 },
      error: { error: { code: 'unavailable', details: { billingEnabled: ['read_failed'] } } } });
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('The request failed');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    const billing = screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on: Billing' });
    expect(billing.disabled).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(billing);
    expect(within(screen.getByRole('dialog')).getByRole<HTMLInputElement>('checkbox').checked).toBe(false);
  });
  it('closes the past-due dialog when a focus read empties the list, then turns billing on without it', async () => {
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValue(reply(200, checklist()));
    client.PATCH.mockResolvedValue(reply(200, checklist(4, true)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('checkbox'));
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Ana Silva')).toBeNull();
    expect(client.PATCH).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Turn on: Billing' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.PATCH).toHaveBeenCalledWith('/api/settings/go-live', { signal: expect.any(AbortSignal),
      body: { revision: 3, billingEnabled: true } });
  });
  it('keeps the past-due dialog open while a save runs, and closes it afterwards if the list emptied', async () => {
    let finish!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValue(reply(200, checklist()));
    client.PATCH.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await waitFor(() => expect(within(dialog).queryByText('Ana Silva')).toBeNull());
    expect(screen.getByRole('dialog')).toBe(dialog);
    await act(async () => { finish(reply(500)); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('The request failed');
  });
  it('keeps the past-due dialog open when a focus read fails and the checklist is kept', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValue(reply(500));
    const user = userEvent.setup(); start(queryClient);
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
  });
  it('closes the past-due dialog when a timed-out save turned billing on, and never sends billing off', async () => {
    // The server applied the save it never answered: the reloads show billing on at the next revision, same past-due list.
    settingsReads.mockResolvedValueOnce(reply(200, { data: gymSettings(3) }))
      .mockResolvedValue(reply(200, { data: { ...gymSettings(4), billingEnabled: true } }));
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValue(reply(200, { data: { ...overdue().data, revision: 4, billingEnabled: true } }));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    const stalled = stalledRequests(), timers = holdTimeouts(saveTimeoutMs);
    try {
      client.PATCH.mockImplementation(stalled.answer);
      await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      timers.expire(saveTimeoutMs);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
      expect(screen.getByRole('alert').textContent).toContain('The save took too long to answer and may still have gone through');
      expect(client.PATCH.mock.calls.length).toBeGreaterThan(0);
      for (const [, init] of client.PATCH.mock.calls as [string, { body: UpdateGoLiveRequest }][]) expect(init.body.billingEnabled).not.toBe(false);
    } finally { timers.restore(); }
  });
  it('sends billing on with the confirmed dates from the past-due dialog', async () => {
    live.mockResolvedValue(reply(200, overdue())); client.PATCH.mockResolvedValue(reply(200, checklist(4, true)));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
    const { id, revision, nextDueOn } = overdue().data.pastDueMemberships[0]!;
    expect(client.PATCH).toHaveBeenCalledTimes(1);
    expect(client.PATCH.mock.calls[0]![1].body).toEqual({ revision: 3, billingEnabled: true, confirmedPastDueDates: [{ id, revision, nextDueOn }] });
  });
  it('says a timed-out save may have gone through when the settings reload after it fails, and focuses that alert', async () => {
    live.mockResolvedValue(reply(200, overdue()));
    settingsReads.mockResolvedValueOnce(reply(200, { data: gymSettings(3) })).mockResolvedValue(reply(500));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    const stalled = stalledRequests(), timers = holdTimeouts(saveTimeoutMs);
    try {
      client.PATCH.mockImplementation(stalled.answer);
      await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      timers.expire(saveTimeoutMs);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      const alert = screen.getByRole('alert'), text = alert.textContent!;
      const reason = 'The save took too long to answer and may still have gone through, and the latest values could not be loaded.';
      expect(text.indexOf(reason)).toBe(0);
      expect(text.indexOf('The request failed. Please try again.')).toBeGreaterThan(reason.length - 1);
      expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined();
      await waitFor(() => expect(document.activeElement).toBe(alert));
    } finally { timers.restore(); }
  });
  it('says Stripe was not checked when the checklist read after it fails, focuses that alert, and clears it on a good retry', async () => {
    live.mockResolvedValueOnce(reply(200, overdue())).mockResolvedValueOnce(reply(500)).mockResolvedValue(reply(200, overdue()));
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 503 },
      error: { error: { code: 'unavailable', details: { billingEnabled: ['read_failed'] } } } });
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const dialog = screen.getByRole('dialog', { name: 'Review past billing dates' });
    await user.click(within(dialog).getByRole('checkbox'));
    await user.click(within(dialog).getByRole('button', { name: 'Confirm dates and turn billing on' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const alert = screen.getByRole('alert'), text = alert.textContent!;
    const reason = 'Stripe could not be checked, so billing was not turned on, and the latest values could not be loaded.';
    expect(text.indexOf(reason)).toBe(0);
    expect(text.indexOf('The request failed. Please try again.')).toBeGreaterThan(reason.length - 1);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on: Billing' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on: Member emails' }).disabled).toBe(false);
  });
  it('keeps the focus on the alert that explains when the read after a refusal fails with no dialog open', async () => {
    let answerRead!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist())).mockReturnValueOnce(new Promise(resolve => { answerRead = resolve; }));
    client.PATCH.mockResolvedValueOnce(reply(409));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('These settings changed elsewhere. The latest values are shown; try again.');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await act(async () => { answerRead(reply(500)); });
    const reason = 'These settings changed elsewhere, so the switch was not changed';
    await waitFor(() => expect(alert.textContent).toContain('The request failed. Please try again.'));
    expect(alert.textContent!.indexOf(reason)).toBe(0);
    expect(screen.getByRole('alert')).toBe(alert);
    expect(document.activeElement).toBe(alert);
  });
  it.each([
    { status: 409, code: 'conflict', refusal: 'no_provider',
      plain: 'Save a working SMS provider in Settings before turning member texts on.',
      reason: 'No working SMS provider is saved, so member texts were not turned on, and the latest values could not be loaded.' },
    { status: 503, code: 'unavailable', refusal: 'read_failed',
      plain: 'The SMS provider could not be checked. Try turning member texts on again.',
      reason: 'The SMS provider could not be checked, so member texts were not turned on, and the latest values could not be loaded.' },
  ])('keeps the $refusal SMS reason when the checklist read after it fails, and clears it on a good retry', async ({ status, code, refusal, plain, reason }) => {
    let answerRead!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist())).mockReturnValueOnce(new Promise(resolve => { answerRead = resolve; }))
      .mockResolvedValue(reply(200, checklist()));
    client.PATCH.mockResolvedValue({ response: { ok: false, status },
      error: { error: { code, details: { memberSmsEnabled: [refusal] } } } });
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member texts' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(plain);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await act(async () => { answerRead(reply(500)); });
    await waitFor(() => expect(alert.textContent).toContain('The request failed. Please try again.'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toBe(alert);
    const text = alert.textContent!;
    expect(text.indexOf(reason)).toBe(0);
    expect(text.indexOf('The request failed. Please try again.')).toBeGreaterThan(reason.length - 1);
    expect(document.activeElement).toBe(alert);
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on: Member texts' }).disabled).toBe(false);
  });
  const noProvider = { refusal: 'a missing SMS provider', name: 'Member texts', status: 409,
    details: { memberSmsEnabled: ['no_provider'] }, plain: 'Save a working SMS provider in Settings before turning member texts on.' };
  /** Refuses a switch, with a good reload after it, then returns the client to move the settings. */
  const refuse = async ({ name, status, details, plain }: { name: string; status: number; details: object | undefined; plain: string }) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    client.PATCH.mockResolvedValue({ response: { ok: false, status }, error: { error: { code: 'refused', details } } });
    const user = userEvent.setup(); start(queryClient);
    await user.click(await screen.findByRole('button', { name: 'Turn on: ' + name }));
    await waitFor(() => expect(live).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe(plain);
    return queryClient;
  };
  const moveSettings = (queryClient: QueryClient, revision = 4) => act(() => {
    queryClient.setQueryData<{ settings: GymSettings; epoch: number }>(gymSettingsKey,
      old => old && { ...old, settings: gymSettings(revision) });
  });
  /** Takes the focus off the alert, as working in another section of the page does. */
  const leaveAlert = () => act(() => (document.activeElement as HTMLElement | null)?.blur());
  it.each([
    noProvider,
    { refusal: 'a change elsewhere', name: 'Billing', status: 409, details: undefined,
      plain: 'These settings changed elsewhere. The latest values are shown; try again.' },
    { refusal: 'an unchecked SMS provider', name: 'Member texts', status: 503, details: { memberSmsEnabled: ['read_failed'] },
      plain: 'The SMS provider could not be checked. Try turning member texts on again.' },
    { refusal: 'an unchecked Stripe', name: 'Billing', status: 503, details: { billingEnabled: ['read_failed'] },
      plain: 'Stripe could not be checked. Try turning billing on again.' },
  ])('drops the reason for $refusal once the settings move past it, so a later failed read does not repeat it', async refusal => {
    const queryClient = await refuse(refusal);
    live.mockResolvedValue(reply(500));
    leaveAlert();
    moveSettings(queryClient);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The request failed. Please try again.'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // Any reason, in either alert, would come before the read error or replace it.
    expect(screen.getByRole('alert').textContent!.indexOf('The request failed. Please try again.')).toBe(0);
  });
  it('shows a failed read that follows no refusal without moving the focus to its alert', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    start(queryClient);
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    live.mockResolvedValue(reply(500));
    moveSettings(queryClient);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The request failed. Please try again.');
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(document.activeElement).not.toBe(alert);
  });
  it('removes a refused switch\'s alert once the settings move past it and the new checklist loads', async () => {
    const queryClient = await refuse(noProvider);
    live.mockResolvedValue(reply(200, checklist(4)));
    leaveAlert();
    moveSettings(queryClient);
    await waitFor(() => expect(live.mock.calls.length).toBeGreaterThan(2));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Turn on: Member texts' }).disabled).toBe(false);
  });
  it('keeps the reason of a focused refusal alert when the settings move, until Retry', async () => {
    const queryClient = await refuse(noProvider);
    const alert = screen.getByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    live.mockResolvedValue(reply(500));
    moveSettings(queryClient);
    await waitFor(() => expect(alert.textContent).toContain('The request failed. Please try again.'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert')).toBe(alert);
    const text = alert.textContent!;
    expect(text).toContain('No working SMS provider');
    expect(text.indexOf('No working SMS provider')).toBeLessThan(text.indexOf('The request failed. Please try again.'));
    expect(document.activeElement).toBe(alert);
    live.mockResolvedValue(reply(200, checklist(4)));
    await userEvent.setup().click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
  it('drops the reason when the settings go back to an earlier revision', async () => {
    const queryClient = await refuse(noProvider);
    expect(queryClient.getQueryData<{ settings: GymSettings }>(gymSettingsKey)?.settings.revision).toBe(3);
    live.mockResolvedValue(reply(500));
    leaveAlert();
    moveSettings(queryClient, 2);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The request failed. Please try again.'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    const text = screen.getByRole('alert').textContent!;
    expect(text.indexOf('The request failed. Please try again.')).toBe(0);
    expect(text).not.toContain('No working SMS provider');
  });
  /** Refuses a switch with the read after it failing, so the read alert holds the reason and the focus. */
  const refuseUnread = async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    let answerRead!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist())).mockReturnValueOnce(new Promise(resolve => { answerRead = resolve; }))
      .mockResolvedValue(reply(500));
    client.PATCH.mockResolvedValue({ response: { ok: false, status: 409 },
      error: { error: { code: 'refused', details: noProvider.details } } });
    const user = userEvent.setup(); start(queryClient);
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member texts' }));
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    await act(async () => { answerRead(reply(500)); });
    const button = await screen.findByRole('button', { name: 'Try again' });
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    return { queryClient, alert, button };
  };
  it('drops an unfocused reason on a move that follows a failed read, without taking the focus', async () => {
    const { queryClient, alert } = await refuseUnread();
    leaveAlert();
    const focus = vi.spyOn(alert, 'focus');
    moveSettings(queryClient);
    await waitFor(() => expect(screen.getByRole('alert').textContent!.indexOf('The request failed. Please try again.')).toBe(0));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });
  it('keeps the reason when the settings move while its Retry button holds the focus', async () => {
    const { queryClient, button } = await refuseUnread();
    act(() => button.focus());
    moveSettings(queryClient);
    await waitFor(() => expect(live).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The request failed. Please try again.'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('No working SMS provider');
    expect(document.activeElement).toBe(screen.getByRole('alert'));
  });
  it('keeps switches locked through overlapping explicit reloads until the latest read answers', async () => {
    let resolveFirst!: (value: unknown) => void, resolveSecond!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist()))
      .mockResolvedValueOnce(reply(500))
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }));
    client.PATCH.mockResolvedValueOnce(reply(409));
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Turn on: Billing' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await vi.waitFor(() => { expect(resolveFirst).toBeDefined(); expect(resolveSecond).toBeDefined(); });
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolveFirst(reply(200, checklist(4, false))); });
    expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { resolveSecond(reply(200, checklist(4, false))); });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Turn on: Billing' }) as HTMLButtonElement).disabled).toBe(false));
  });
  it('reloads the checklist on Retry when both a background checklist read and the settings read failed', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    let resolveSettingsReload!: (value: unknown) => void;
    live.mockResolvedValueOnce(reply(200, checklist()))
      .mockResolvedValueOnce(reply(500))
      .mockResolvedValue(reply(200, checklist(3, true)));
    settingsReads.mockResolvedValueOnce(reply(200, { data: gymSettings(3) }))
      .mockResolvedValueOnce(reply(500))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSettingsReload = resolve; }));
    const user = userEvent.setup(); start(queryClient);
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await vi.waitFor(() => expect(live).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await queryClient.refetchQueries({ queryKey: gymSettingsKey, exact: true }); });
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await user.click(retry);
    await vi.waitFor(() => {
      expect(live).toHaveBeenCalledTimes(3);
      expect(settingsReads).toHaveBeenCalledTimes(3);
    });
    await act(async () => { resolveSettingsReload(reply(200, { data: gymSettings(3) })); });
    expect(await screen.findByRole('button', { name: 'Turn off: Billing' })).toBeDefined();
  });
});

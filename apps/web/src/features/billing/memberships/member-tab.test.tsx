// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import type { Membership, Plan, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { createShellServices } from '../../../app/services.js';
import type { BillingClient } from '../catalog/api.js';
import { MembershipPanel } from './member-tab.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-10-27T00:30:00Z';
const plan: Plan = { id: id(2), createdAt, name: 'Unlimited classes', currency: 'CAD', amountCents: 10000, interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
const membership: Membership = { id: id(3), createdAt, memberId: id(4), householdId: id(5), planId: plan.id, status: 'active', currency: 'CAD', amountCents: 10000, interval: 'monthly', startsOn: '2026-10-01', nextDueOn: '2026-11-01', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: null,
  scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null, discount: null, revision: 1 };
const premium: Plan = { ...plan, id: id(7), name: 'Premium', amountCents: 15000 };
function start(role: StaffRole, options: { plans?: Plan[]; row?: Membership; call?: () => Promise<unknown>; cache?: QueryClient; history?: BillingClient['freezeHistory'] } = {}) {
  const data: ShellBootstrap = { gym: { id: id(1), name: 'Academy', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] }, session: { userId: id(6), displayName: 'Test User', roles: [role], member: false }, login: { password: true, magicLink: false } };
  const client = { plans: vi.fn(async () => options.plans ?? [plan]), memberships: vi.fn(async () => [options.row ?? membership]),
    freezeHistory: vi.fn(options.history ?? (async () => ({ data: [], pagination: { limit: 10, offset: 0, total: 0 } }))),
    call: vi.fn(options.call ?? (async () => membership)),
    member: vi.fn(async () => ({ householdId: membership.householdId })), householdBilling: vi.fn(async () => ({ billingDay: null })),
    settings: vi.fn(async () => { throw new Error('Settings are restricted'); }),
  } as unknown as BillingClient;
  render(<QueryClientProvider client={options.cache ?? new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => data)}>
      <MembershipPanel gymId={data.gym.id} memberId={membership.memberId} manage={canStaff([role], 'plans.manage')} client={client} now={new Date(createdAt)}/>
    </ShellServicesContext.Provider>
  </QueryClientProvider>);
  return client;
}
afterEach(cleanup);
it.each([
  { name: 'monthly', interval: 'monthly' as const, status: 'active' as const, due: '2026-11-01', label: 'Nov 1, 2026', resume: '' },
  { name: 'annual', interval: 'annual' as const, status: 'active' as const, due: '2027-02-28', label: 'Feb 28, 2027', resume: '' },
  { name: 'several cycles', interval: 'monthly' as const, status: 'active' as const, due: '2026-11-01', label: 'Nov 1, 2026', resume: '2027-03-01' },
  { name: 'trial', interval: 'monthly' as const, status: 'trial' as const, due: '2026-11-13', label: 'Nov 13, 2026', resume: '' },
])('names the first skipped billing date for a $name freeze before submitting', async scenario => {
  const client = start('admin', { row: { ...membership, interval: scenario.interval, status: scenario.status, nextDueOn: scenario.due,
    trialEndsOn: scenario.status === 'trial' ? scenario.due : null } });
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
  expect(screen.getByText('Freezing skips the billing date ' + scenario.label + ', even if you resume immediately or freeze during a trial. A later resume date can skip more cycles. Leave the resume date blank to freeze until staff resume it.')).toBeDefined();
  if (scenario.resume) fireEvent.change(screen.getByLabelText('Resume date (optional)'), { target: { value: scenario.resume } });
  expect(client.call).not.toHaveBeenCalled();
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('freezeMembership', { revision: 1, resumesOn: scenario.resume || null }, { membershipId: membership.id }));
});
it('loads historical skipped and resulting dates on demand, pages them, and keeps them after resume', async () => {
  const event = { id: id(10), occurredAt: createdAt, skippedDueOn: '2026-02-01', nextDueOn: '2026-06-01' };
  const history = vi.fn(async (_membershipId: string, offset = 0) => ({ data: [{ ...event, id: id(10 + offset), skippedDueOn: offset ? '2025-02-01' : event.skippedDueOn }],
    pagination: { limit: 10, offset, total: 11 } }));
  const client = start('front_desk', { history, row: { ...membership, nextDueOn: '2027-01-01' } });
  await screen.findByRole('heading', { name: plan.name });
  expect(client.freezeHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Freeze history' }));
  expect(await screen.findByText('Skipped billing date: Feb 1, 2026')).toBeDefined();
  expect(screen.getByText('Next billing date after this freeze: Jun 1, 2026')).toBeDefined();
  expect(screen.getByText('Frozen on Oct 26, 2026, 5:30 PM')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Older freezes' }));
  expect(await screen.findByText('Skipped billing date: Feb 1, 2025')).toBeDefined();
  expect(history).toHaveBeenLastCalledWith(membership.id, 10);
  fireEvent.click(screen.getByRole('button', { name: 'Newer freezes' }));
  expect(await screen.findByText('Skipped billing date: Feb 1, 2026')).toBeDefined();
});
it('shows an empty history and retries a failed history read', async () => {
  const history = vi.fn<BillingClient['freezeHistory']>().mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ data: [], pagination: { limit: 10, offset: 0, total: 0 } });
  start('front_desk', { history });
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze history' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('No freezes recorded.')).toBeDefined();
});
it('keeps the list while paging and returns to the first page after a freeze', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const event = { id: id(10), occurredAt: createdAt, skippedDueOn: '2026-02-01', nextDueOn: '2026-03-01' };
  const response = (offset: number) => ({ data: [{ ...event, id: id(10 + offset), skippedDueOn: offset ? '2025-02-01' : event.skippedDueOn }],
    pagination: { limit: 10, offset, total: 11 } });
  let completePage!: (value: ReturnType<typeof response>) => void;
  let completeRevision!: (value: ReturnType<typeof response>) => void;
  const history = vi.fn<BillingClient['freezeHistory']>().mockResolvedValueOnce(response(0))
    .mockImplementationOnce(() => new Promise(resolve => { completePage = resolve; }))
    .mockImplementation(() => new Promise(resolve => { completeRevision = resolve; }));
  const frozen = { ...membership, status: 'frozen' as const, revision: 2 };
  const client = start('admin', { cache, history, call: async () => frozen });
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze history' }));
  await screen.findByText('Skipped billing date: Feb 1, 2026');
  fireEvent.click(screen.getByRole('button', { name: 'Older freezes' }));
  await waitFor(() => expect(history).toHaveBeenLastCalledWith(membership.id, 10));
  expect(screen.getByText('Skipped billing date: Feb 1, 2026')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Older freezes' }).hasAttribute('disabled')).toBe(true);
  await act(async () => completePage(response(10)));
  await screen.findByText('Skipped billing date: Feb 1, 2025');
  vi.mocked(client.memberships).mockResolvedValue([frozen]);
  fireEvent.click(screen.getByRole('button', { name: 'Freeze' }));
  save();
  await waitFor(() => expect(history).toHaveBeenLastCalledWith(membership.id, 0));
  expect(screen.getByText('Skipped billing date: Feb 1, 2025')).toBeDefined();
  await act(async () => completeRevision(response(0)));
  await screen.findByText('Skipped billing date: Feb 1, 2026');
  expect(screen.queryByRole('button', { name: 'Newer freezes' })).toBeNull();
});
it('refreshes an open member profile and the member list after membership changes, within its gym', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const profileKey = ['members', id(1), membership.memberId], listKey = ['members', id(1), 'list'], foreignKey = ['members', id(99), 'list'];
  const before = { status: 'visitor', revision: 1 }, after = { status: 'active', revision: 2 };
  for (const key of [profileKey, listKey, foreignKey]) cache.setQueryData(key, before);
  const observer = new QueryObserver(cache, { queryKey: profileKey, queryFn: async () => after });
  const unsubscribe = observer.subscribe(() => {});
  try {
    start('admin', { cache });
    const form = await openEdit();
    fireEvent.change(form.price, { target: { value: '120' } });
    save();
    await screen.findByText('Membership saved.');
    await waitFor(() => expect(cache.getQueryData(profileKey)).toEqual(after));
    expect(cache.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(cache.getQueryState(foreignKey)?.isInvalidated).toBe(false);
  } finally { unsubscribe(); cache.clear(); }
});
it('shows front desk the plan name with billing.read and hides assignment controls', async () => {
  const client = start('front_desk');
  expect(await screen.findByRole('heading', { name: plan.name })).toBeDefined();
  expect(client.plans).toHaveBeenCalledOnce();
  expect(client.settings).not.toHaveBeenCalled();
  expect(client.member).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Assign a plan' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
});
it('uses the bootstrap timezone for the assignment date without fetching settings', async () => {
  const client = start('admin');
  expect((await screen.findByLabelText('Starts on') as HTMLInputElement).value).toBe('2026-10-26');
  expect(client.settings).not.toHaveBeenCalled();
});
it('does not fetch plan names without billing.read', async () => {
  const client = start('coach');
  // The next billing date reads as a date, like the rest of the admin.
  await screen.findByText('Nov 1, 2026');
  expect(client.plans).not.toHaveBeenCalled();
});
async function openEdit() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change price' }));
  return { price: await screen.findByLabelText(/^Price/) as HTMLInputElement };
}
const save = () => fireEvent.click(screen.getAllByRole('button', { name: 'Save' }).at(-1)!);
it('sends a custom price with the membership currency and revision', async () => {
  const client = start('admin', { row: { ...membership, revision: 4 } });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '85.5' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateMembership', { revision: 4, price: { amountCents: 8550, currency: 'CAD' } }, { membershipId: membership.id }));
});
it('shows the current plan price without claiming how the membership price was set', async () => {
  start('admin', { row: { ...membership, amountCents: 8000 } });
  expect(await screen.findByText(/^Plan price now .*100\.00 \/ Monthly$/)).toBeDefined();
  cleanup();
  start('admin');
  await screen.findByRole('heading', { name: plan.name });
  expect(screen.queryByText(/Plan price now/)).toBeNull();
});
it('describes a retained membership price after the plan price changes', async () => {
  start('front_desk', { plans: [{ ...plan, amountCents: 12000 }] });
  expect(await screen.findByText(/^Plan price now .*120\.00 \/ Monthly$/)).toBeDefined();
  expect(screen.getByText(/Active .*100\.00 \/ Monthly/)).toBeDefined();
});
it('does not compare prices across billing intervals or currencies', async () => {
  start('front_desk', { row: { ...membership, interval: 'annual', amountCents: 80000 } });
  await screen.findByRole('heading', { name: plan.name });
  expect(screen.queryByText(/Plan price now/)).toBeNull();
  cleanup();
  start('front_desk', { row: { ...membership, currency: 'USD', amountCents: 8000 } });
  await screen.findByRole('heading', { name: plan.name });
  expect(screen.queryByText(/Plan price now/)).toBeNull();
});
it('offers no plan change in the edit form, which sends only the price', async () => {
  const client = start('admin', { plans: [plan, premium] });
  const form = await openEdit();
  // The assignment form's plan select (unnamed) is the only one on the tab.
  expect(document.querySelectorAll('select[name="planId"]')).toHaveLength(0);
  expect(await screen.findAllByLabelText('Plan')).toHaveLength(1);
  fireEvent.change(form.price, { target: { value: '120' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateMembership', { revision: 1, price: { amountCents: 12000, currency: 'CAD' } }, { membershipId: membership.id }));
  expect(Object.keys(vi.mocked(client.call).mock.calls[0]![1] as object).sort()).toEqual(['price', 'revision']);
});
it('sends nothing when the price is blank', async () => {
  const client = start('admin');
  await openEdit();
  save();
  expect(await screen.findByText('Enter a price different from the current one.')).toBeDefined();
  expect(client.call).not.toHaveBeenCalled();
});
it('shows and takes a zero-decimal membership price in whole yen', async () => {
  const yenPlan = { ...plan, currency: 'JPY', amountCents: 12000 }, row = { ...membership, currency: 'JPY', amountCents: 9000 };
  const client = start('admin', { plans: [yenPlan], row });
  expect(await screen.findByText(/¥9,000/)).toBeDefined(); expect(await screen.findByText(/^Plan price now ¥12,000 \/ Monthly$/)).toBeDefined();
  const form = await openEdit();
  expect(form.price.placeholder).toBe('9000');
  fireEvent.change(form.price, { target: { value: '9500.5' } });
  save();
  expect(await screen.findByText('Enter a valid price, with no more decimal places than the currency uses.')).toBeDefined();
  expect(client.call).not.toHaveBeenCalled();
  fireEvent.change(form.price, { target: { value: '9500' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateMembership', { revision: 1, price: { amountCents: 9500, currency: 'JPY' } }, { membershipId: membership.id }));
});
it('refuses a price with too many decimals and the current price', async () => {
  const client = start('admin');
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '85.555' } });
  save();
  expect(await screen.findByText('Enter a valid price, with no more decimal places than the currency uses.')).toBeDefined();
  fireEvent.change(form.price, { target: { value: '100' } });
  save();
  expect(await screen.findByText('Enter a price different from the current one.')).toBeDefined();
  expect(client.call).not.toHaveBeenCalled();
});
it('refuses a price the browser could not read as a number instead of treating it as blank', async () => {
  const client = start('admin', { plans: [plan, premium] });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '120,00' } });
  save();
  expect(await screen.findByText('Enter a valid price, with no more decimal places than the currency uses.')).toBeDefined();
  expect(client.call).not.toHaveBeenCalled();
});
it('sends the revision the form opened with, so a plan change made meanwhile is not undone', async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = start('admin', { plans: [plan, premium], cache });
  const form = await openEdit();
  vi.mocked(client.memberships).mockResolvedValue([{ ...membership, planId: premium.id, amountCents: premium.amountCents, revision: 2 }]);
  await cache.invalidateQueries();
  await screen.findByRole('heading', { name: premium.name });
  fireEvent.change(form.price, { target: { value: '90' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateMembership', { revision: 1, price: { amountCents: 9000, currency: 'CAD' } }, { membershipId: membership.id }));
});
it('saves a price-only edit when the membership\'s plan is inactive', async () => {
  const client = start('admin', { plans: [{ ...plan, active: false }, premium] });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '90' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('updateMembership', { revision: 1, price: { amountCents: 9000, currency: 'CAD' } }, { membershipId: membership.id }));
});
it('shows the usual conflict message on a 409', async () => {
  start('admin', { call: async () => { throw new ApiError(409, 'conflict', ['membership_changed']); } });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '50' } });
  save();
  expect(await screen.findByText(/Reload and review before saving/)).toBeDefined();
});

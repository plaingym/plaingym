// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
it('says hidden entries when an empty freeze page has a nonzero total, and none only at a zero total', async () => {
  const hidden = vi.fn(async () => ({ data: [], pagination: { limit: 10, offset: 0, total: 3 } }));
  start('front_desk', { history: hidden });
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze history' }));
  expect(await screen.findByText("Some freeze entries can't be shown.")).toBeDefined();
  expect(screen.queryByText('No freezes recorded.')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Older freezes' })).toBeNull();
  cleanup();
  start('front_desk', { history: vi.fn(async () => ({ data: [], pagination: { limit: 10, offset: 0, total: 0 } })) });
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze history' }));
  expect(await screen.findByText('No freezes recorded.')).toBeDefined();
  expect(screen.queryByText("Some freeze entries can't be shown.")).toBeNull();
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
it('refreshes the household billing date after a refused assignment and keeps the draft', async () => {
  const client = start('admin', { call: async () => { throw new ApiError(409, 'conflict', ['household_billing_date']); } });
  const assign = await screen.findByRole('button', { name: 'Assign a plan' });
  const startsOn = screen.getByLabelText<HTMLInputElement>('Starts on');
  const nextDueOn = screen.getByLabelText<HTMLInputElement>('Next billing date');
  const firstPeriod = screen.getByLabelText<HTMLSelectElement>('First period');
  fireEvent.change(startsOn, { target: { value: '2026-10-28' } });
  fireEvent.change(firstPeriod, { target: { value: 'next_billing_date' } });
  expect(nextDueOn.value).toBe('2026-11-01');
  const reads = vi.mocked(client.memberships).mock.calls.length;
  vi.mocked(client.memberships).mockResolvedValue([{ ...membership, nextDueOn: '2026-11-02' }]);
  fireEvent.submit(assign.closest('form')!);
  expect(await screen.findByText("The household's next billing date has changed. The form now shows the new date; check it and assign again.")).toBeDefined();
  await waitFor(() => expect(nextDueOn.value).toBe('2026-11-02'));
  expect(vi.mocked(client.memberships).mock.calls.length).toBeGreaterThan(reads);
  expect(startsOn.value).toBe('2026-10-28');
  expect(firstPeriod.value).toBe('next_billing_date');
});
it('replaces a typed billing date with the reloaded household date after a refused assignment', async () => {
  const client = start('admin', { call: async () => { throw new ApiError(409, 'conflict', ['household_billing_date']); } });
  const assign = await screen.findByRole('button', { name: 'Assign a plan' });
  const startsOn = screen.getByLabelText<HTMLInputElement>('Starts on');
  const nextDueOn = screen.getByLabelText<HTMLInputElement>('Next billing date');
  fireEvent.change(startsOn, { target: { value: '2026-10-28' } });
  fireEvent.change(nextDueOn, { target: { value: '2026-11-15' } });
  vi.mocked(client.memberships).mockResolvedValue([{ ...membership, nextDueOn: '2026-11-02' }]);
  fireEvent.submit(assign.closest('form')!);
  expect(await screen.findByText("The household's next billing date has changed. The form now shows the new date; check it and assign again.")).toBeDefined();
  await waitFor(() => expect(nextDueOn.value).toBe('2026-11-02'));
  expect(startsOn.value).toBe('2026-10-28');
});
it('refreshes archived plans and retries with the displayed plan, keeping dates and clearing its old discount', async () => {
  const client = start('admin', { plans: [plan, premium] });
  const assign = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = within(assign.closest('form')!);
  const picker = form.getByLabelText<HTMLSelectElement>('Plan');
  const nextDueOn = form.getByLabelText<HTMLInputElement>('Next billing date');
  fireEvent.change(picker, { target: { value: premium.id } });
  fireEvent.change(nextDueOn, { target: { value: '2026-11-15' } });
  fireEvent.change(form.getByLabelText('Discount'), { target: { value: 'code' } });
  fireEvent.change(form.getByLabelText('Discount code'), { target: { value: 'PREMIUM' } });
  vi.mocked(client.plans).mockResolvedValue([plan]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['plan_inactive']));
  fireEvent.click(assign);
  expect(client.call).toHaveBeenNthCalledWith(1, 'assignMembership', expect.objectContaining({ planId: premium.id, discount: { code: 'PREMIUM' } }), {});
  await waitFor(() => expect(form.queryByRole('option', { name: /^Premium/ })).toBeNull());
  expect(await screen.findByText('That plan is no longer active.')).toBeDefined();
  expect(picker.value).toBe(plan.id);
  // The refusal already explains the removal, so the form adds no replacement notice.
  expect(form.queryByText(/form now shows/)).toBeNull();
  expect(form.getByLabelText('Discount')).toHaveProperty('value', 'none');
  expect(form.queryByLabelText('Discount code')).toBeNull();
  expect(nextDueOn.value).toBe('2026-11-15');
  fireEvent.click(await form.findByRole('button', { name: 'Assign a plan' }));
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'assignMembership', {
    memberId: membership.memberId, householdId: membership.householdId, planId: plan.id,
    startsOn: '2026-10-26', nextDueOn: '2026-11-15', firstPeriod: 'prorate_now',
  }, {}));
  expect(await screen.findByText('Membership saved.')).toBeDefined();
});
const plansKey = ['billing', id(1), 'plans'];
const beginner: Plan = { ...plan, id: id(8), name: 'Beginner', amountCents: 5000 };
async function assignmentForm(plans: Plan[]) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = start('admin', { plans, cache });
  const assign = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = within(assign.closest('form')!);
  fireEvent.change(form.getByLabelText('Discount'), { target: { value: 'code' } });
  fireEvent.change(form.getByLabelText('Discount code'), { target: { value: 'WELCOME' } });
  const refresh = async (next: Plan[]) => {
    vi.mocked(client.plans).mockResolvedValue(next);
    await act(async () => { await cache.invalidateQueries({ queryKey: plansKey }); });
  };
  return { client, assign, form, picker: form.getByLabelText<HTMLSelectElement>('Plan'), refresh };
}
it('keeps the shown default plan and its discount when a refresh reorders the plans', async () => {
  const { client, assign, form, picker, refresh } = await assignmentForm([plan, premium]);
  expect(picker.value).toBe(plan.id);
  await refresh([beginner, premium, plan]);
  await waitFor(() => expect(within(picker).getAllByRole('option')[0]!.textContent).toMatch(/^Beginner/));
  expect(picker.value).toBe(plan.id);
  expect(form.getByLabelText<HTMLInputElement>('Discount code').value).toBe('WELCOME');
  expect(form.queryByText(/form now shows/)).toBeNull();
  fireEvent.click(assign);
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('assignMembership', expect.objectContaining({ planId: plan.id, discount: { code: 'WELCOME' } }), {}));
});
it('shows an active replacement with a notice when a refresh removes the shown plan, and clears the notice on a selection', async () => {
  const { client, assign, form, picker, refresh } = await assignmentForm([plan, premium, beginner]);
  await refresh([premium, { ...plan, active: false }, beginner]);
  expect(await form.findByText('The plan shown before is no longer active, so the form now shows Premium. Review the plan and discount before assigning.')).toBeDefined();
  expect(picker.value).toBe(premium.id);
  expect(form.queryByRole('option', { name: /^Unlimited classes/ })).toBeNull();
  expect(form.getByLabelText('Discount')).toHaveProperty('value', 'none');
  expect(form.queryByLabelText('Discount code')).toBeNull();
  vi.mocked(client.call).mockRejectedValueOnce(new Error('Offline'));
  fireEvent.click(assign);
  await waitFor(() => expect(client.call).toHaveBeenCalledOnce());
  const sent = vi.mocked(client.call).mock.calls[0]![1] as Record<string, unknown>;
  expect(sent.planId).toBe(premium.id);
  expect(sent).not.toHaveProperty('discount');
  await form.findByRole('button', { name: 'Assign a plan' });
  // A failed save leaves the notice until staff choose a plan.
  expect(form.getByText(/form now shows Premium/)).toBeDefined();
  fireEvent.change(picker, { target: { value: beginner.id } });
  expect(form.queryByText(/form now shows/)).toBeNull();
  expect(picker.value).toBe(beginner.id);
});
it.each([
  { restoresPlan: false, shown: premium },
  { restoresPlan: true, shown: plan },
])('keeps the latest replacement notice across an earlier save (submitted plan restored: $restoresPlan)', async ({ restoresPlan, shown }) => {
  const { client, assign, form, refresh } = await assignmentForm([plan, premium]);
  const reloaded = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockReturnValue(reloaded.promise);
  fireEvent.click(assign);
  await waitFor(() => expect(client.call).toHaveBeenCalledWith('assignMembership', expect.objectContaining({ planId: plan.id, discount: { code: 'WELCOME' } }), {}));
  await waitFor(() => expect(vi.mocked(client.memberships).mock.results.some(result => result.value === reloaded.promise)).toBe(true));
  await refresh([premium, { ...plan, active: false }]);
  expect(await form.findByText(/form now shows Premium/)).toBeDefined();
  if (restoresPlan) {
    await refresh([plan, { ...premium, active: false }]);
    expect(await form.findByText(/form now shows Unlimited classes/)).toBeDefined();
  }
  reloaded.resolve([membership]);
  expect(await screen.findByText('Membership saved.')).toBeDefined();
  // The saved form resets into a new element, usable again once the save ends.
  const usable = within((await screen.findByRole('button', { name: 'Assign a plan' })).closest('form')!);
  expect(usable.getByLabelText<HTMLSelectElement>('Plan').value).toBe(shown.id);
  expect(usable.getByText(`The plan shown before is no longer active, so the form now shows ${shown.name}. Review the plan and discount before assigning.`)).toBeDefined();
});
it.each(['fails', 'returns the same plans'])('keeps a background replacement notice when a later refusal reload %s', async outcome => {
  const { client, assign, form, picker, refresh } = await assignmentForm([plan, premium]);
  const assignment = Promise.withResolvers<never>();
  vi.mocked(client.call).mockReturnValueOnce(assignment.promise);
  fireEvent.click(assign);
  await waitFor(() => expect(client.call).toHaveBeenCalledOnce());

  await refresh([premium, { ...plan, active: false }]);
  expect(await form.findByText(/form now shows Premium/)).toBeDefined();
  const reads = vi.mocked(client.plans).mock.calls.length;
  if (outcome === 'fails') vi.mocked(client.plans).mockRejectedValueOnce(new Error('Offline'));
  assignment.reject(new ApiError(409, 'conflict', ['plan_inactive']));

  expect(await screen.findByText('That plan is no longer active.')).toBeDefined();
  await form.findByRole('button', { name: 'Assign a plan' });
  expect(vi.mocked(client.plans).mock.calls.length).toBeGreaterThan(reads);
  expect(picker.value).toBe(premium.id);
  expect(form.getByText(/form now shows Premium/)).toBeDefined();
});
it('limits an inactive-plan refusal to its own refresh, so a later removal still shows the notice', async () => {
  const { client, assign, form, picker, refresh } = await assignmentForm([plan, premium]);
  vi.mocked(client.plans).mockRejectedValueOnce(new Error('Offline'));
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['plan_inactive']));
  fireEvent.click(assign);
  expect(await screen.findByText('That plan is no longer active.')).toBeDefined();
  // The refresh failed, so the list and the shown plan stay as they were.
  expect(await screen.findByText('Could not load memberships. Please try again.')).toBeDefined();
  await form.findByRole('button', { name: 'Assign a plan' });
  expect(picker.value).toBe(plan.id);
  // Another membership action replaces the refusal message.
  fireEvent.click(screen.getByRole('button', { name: 'Cancel membership' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
  expect(await screen.findByText('Membership saved.')).toBeDefined();
  expect(screen.queryByText('That plan is no longer active.')).toBeNull();
  await refresh([premium, { ...plan, active: false }]);
  expect(await form.findByText('The plan shown before is no longer active, so the form now shows Premium. Review the plan and discount before assigning.')).toBeDefined();
  expect(picker.value).toBe(premium.id);
});
it('shows the existing empty state when the last active plan is archived', async () => {
  const client = start('admin');
  const assign = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = assign.closest('form')!;
  vi.mocked(client.plans).mockResolvedValue([{ ...plan, active: false }]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['plan_inactive']));
  fireEvent.click(assign);
  expect(await screen.findByText('Add an active plan in the billing catalog first.')).toBeDefined();
  expect(screen.getByText('That plan is no longer active.')).toBeDefined();
  expect(within(form).queryByLabelText('Plan')).toBeNull();
  expect(within(form).queryByRole('button', { name: 'Assign a plan' })).toBeNull();
  fireEvent.submit(form);
  expect(client.call).toHaveBeenCalledTimes(1);
});
it('closes a refused Freeze form and resumes with the refreshed revision and billing date', async () => {
  const client = start('admin');
  fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
  fireEvent.change(screen.getByLabelText('Resume date (optional)'), { target: { value: '2026-12-01' } });
  vi.mocked(client.memberships).mockResolvedValue([{ ...membership, status: 'frozen', revision: 2, nextDueOn: '2026-12-01', frozenAt: createdAt }]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_status']));
  save();
  expect(await screen.findByText("This membership's status has changed. The tab now shows its current status.")).toBeDefined();
  expect(screen.queryByLabelText('Resume date (optional)')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
  expect(screen.getByLabelText('Next billing date', { selector: 'input[name="date"]' })).toHaveProperty('value', '2026-12-01');
  save();
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'resumeMembership', { revision: 2, nextDueOn: '2026-12-01' }, { membershipId: membership.id }));
});
it.each([
  { button: 'Freeze', status: 'active', field: 'Resume date (optional)', selector: 'input[name="date"]', value: '2026-12-01', nextValue: '2026-12-10', operation: 'freezeMembership', reloaded: { ...membership, status: 'active' as const, revision: 2, nextDueOn: '2026-11-15' }, retryArgs: { revision: 2, resumesOn: '2026-12-10' } },
  { button: 'Resume', status: 'frozen', field: 'Next billing date', selector: 'input[name="date"]', value: '2026-12-01', nextValue: '2026-12-15', operation: 'resumeMembership', reloaded: { ...membership, status: 'frozen' as const, revision: 2, nextDueOn: '2026-11-15' }, retryArgs: { revision: 2, nextDueOn: '2026-12-15' } },
] as const)('closes a refused $button form on a changed membership and retries with the reloaded revision', async ({ button, status, field, selector, value, nextValue, operation, reloaded, retryArgs }) => {
  const client = start('admin', { row: { ...membership, status } });
  fireEvent.click(await screen.findByRole('button', { name: button }));
  fireEvent.change(screen.getByLabelText(field, { selector }), { target: { value } });
  vi.mocked(client.memberships).mockResolvedValue([reloaded]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_changed']));
  save();
  expect(await screen.findByText('This record or the household billing date changed. Reload and review before saving.')).toBeDefined();
  expect(screen.queryByLabelText(field, { selector })).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: button }).matches(':disabled')).toBe(false));
  expect(await screen.findByText('Nov 15, 2026')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: button }));
  fireEvent.change(screen.getByLabelText(field, { selector }), { target: { value: nextValue } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, operation, retryArgs, { membershipId: membership.id }));
});
it('closes the Change price form on a changed membership and compares and retries against the reloaded price and revision', async () => {
  const client = start('admin');
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '50' } });
  vi.mocked(client.memberships).mockResolvedValue([{ ...membership, revision: 2, amountCents: 5000 }]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_changed']));
  save();
  expect(await screen.findByText('This record or the household billing date changed. Reload and review before saving.')).toBeDefined();
  expect(screen.queryByLabelText(/^Price/)).toBeNull();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change price' }).matches(':disabled')).toBe(false));
  const reopened = await openEdit();
  expect(reopened.price.placeholder).toBe('50.00');
  fireEvent.change(reopened.price, { target: { value: '50' } });
  save();
  expect(await screen.findByText('Enter a price different from the current one.')).toBeDefined();
  expect(client.call).toHaveBeenCalledTimes(1);
  fireEvent.change(reopened.price, { target: { value: '75' } });
  save();
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'updateMembership', { revision: 2, price: { amountCents: 7500, currency: 'CAD' } }, { membershipId: membership.id }));
});
it('keeps Cancel membership disabled until the reload after a changed membership resolves', async () => {
  const user = userEvent.setup();
  const client = start('admin');
  await user.click(await screen.findByRole('button', { name: 'Cancel membership' }));
  const refreshed = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockReturnValue(refreshed.promise);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_changed']));
  await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
  expect(await screen.findByText('This record or the household billing date changed. Reload and review before saving.')).toBeDefined();
  const cancelButton = screen.getByRole('button', { name: 'Cancel membership' });
  expect(cancelButton.matches(':disabled')).toBe(true);
  await user.click(cancelButton);
  expect(screen.queryByRole('button', { name: 'Confirm cancellation' })).toBeNull();
  refreshed.resolve([{ ...membership, revision: 2 }]);
  await waitFor(() => expect(cancelButton.matches(':disabled')).toBe(false));
  await user.click(cancelButton);
  const confirmButton = screen.getByRole('button', { name: 'Confirm cancellation' });
  expect(confirmButton.matches(':disabled')).toBe(false);
  await user.click(confirmButton);
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'cancelMembership', { revision: 2 }, { membershipId: membership.id }));
});
it.each([
  { reason: 'membership_status', message: "This membership's status has changed. The tab now shows its current status.", closes: true },
  { reason: 'membership_cancelled', message: "This membership has been cancelled, so it can't be changed.", closes: true },
  { reason: 'household_billing_date', message: "The household's next billing date has changed. The form now shows the new date; check it and assign again.", closes: false },
  { reason: 'household_join_date', message: 'This household has no other active memberships, so billing starts on the start date. The form now shows it; check it and assign again.', closes: false },
] as const)('keeps buttons disabled after $reason until the member rows reload resolves, then retries with the reloaded revision', async ({ reason, message, closes }) => {
  const user = userEvent.setup();
  const client = start('admin');
  await user.click(await screen.findByRole('button', { name: 'Cancel membership' }));
  const refreshed = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockImplementation(query => query.memberId ? refreshed.promise : Promise.resolve([{ ...membership, revision: 2 }]));
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', [reason]));
  await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
  expect(await screen.findByText(message)).toBeDefined();
  const cancelButton = screen.getByRole('button', { name: 'Cancel membership' });
  expect(cancelButton.matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button', { name: 'Confirm cancellation' }) === null).toBe(closes);
  await user.click(cancelButton);
  expect(client.call).toHaveBeenCalledTimes(1);
  refreshed.resolve([{ ...membership, revision: 2 }]);
  await waitFor(() => expect(cancelButton.matches(':disabled')).toBe(false));
  if (closes) await user.click(cancelButton);
  const confirmButton = screen.getByRole('button', { name: 'Confirm cancellation' });
  expect(confirmButton.matches(':disabled')).toBe(false);
  await user.click(confirmButton);
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'cancelMembership', { revision: 2 }, { membershipId: membership.id }));
});
it.each([
  { reason: 'household_billing_date', message: "The household's next billing date has changed. The form now shows the new date; check it and assign again.",
    reloaded: [{ ...membership, nextDueOn: '2026-11-02', revision: 2 }], expectedDue: '2026-11-02' },
  { reason: 'household_join_date', message: 'This household has no other active memberships, so billing starts on the start date. The form now shows it; check it and assign again.',
    reloaded: [{ ...membership, status: 'cancelled' as const, cancelledAt: createdAt, revision: 2 }], expectedDue: '2026-10-26' },
])('keeps the assignment form disabled after $reason until the member rows reload resolves', async ({ reason, message, reloaded, expectedDue }) => {
  const user = userEvent.setup();
  const client = start('admin');
  const assignButton = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = within(assignButton.closest('form')!);
  const refreshed = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockImplementation(query => query.memberId ? refreshed.promise : Promise.resolve(reloaded));
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', [reason]));
  await user.click(assignButton);
  expect(await screen.findByText(message)).toBeDefined();
  const loadingButton = form.getByRole('button', { name: 'Loading the latest details…' });
  expect(loadingButton.matches(':disabled')).toBe(true);
  await user.click(loadingButton);
  expect(client.call).toHaveBeenCalledTimes(1);
  refreshed.resolve(reloaded);
  const readyButton = await form.findByRole('button', { name: 'Assign a plan' });
  await waitFor(() => expect(readyButton.matches(':disabled')).toBe(false));
  await waitFor(() => expect(form.getByLabelText<HTMLInputElement>('Next billing date').value).toBe(expectedDue));
  await user.click(readyButton);
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'assignMembership', expect.objectContaining({ nextDueOn: expectedDue }), {}));
});
it('keeps the assignment form disabled after a billing date refusal until the household billing reload resolves', async () => {
  const user = userEvent.setup();
  const client = start('admin');
  const assignButton = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = within(assignButton.closest('form')!);
  const reloaded = [{ ...membership, nextDueOn: '2026-11-02', revision: 2 }];
  const household = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockImplementation(query => query.memberId ? Promise.resolve(reloaded) : household.promise);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['household_billing_date']));
  await user.click(assignButton);
  expect(await screen.findByText("The household's next billing date has changed. The form now shows the new date; check it and assign again.")).toBeDefined();
  await waitFor(() => expect(client.memberships).toHaveBeenCalledWith({ memberId: membership.memberId }));
  const loadingButton = form.getByRole('button', { name: 'Loading the latest details…' });
  expect(loadingButton.matches(':disabled')).toBe(true);
  await user.click(loadingButton);
  expect(client.call).toHaveBeenCalledTimes(1);
  household.resolve(reloaded);
  const readyButton = await form.findByRole('button', { name: 'Assign a plan' });
  await waitFor(() => expect(readyButton.matches(':disabled')).toBe(false));
  expect(form.getByLabelText<HTMLInputElement>('Next billing date').value).toBe('2026-11-02');
  await user.click(readyButton);
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'assignMembership', expect.objectContaining({ nextDueOn: '2026-11-02' }), {}));
});
it('never shows the loading text after a plain 500 failure on Assign a plan', async () => {
  const user = userEvent.setup();
  const failed = Promise.withResolvers<never>();
  const client = start('admin', { call: () => failed.promise });
  const assignButton = await screen.findByRole('button', { name: 'Assign a plan' });
  const form = within(assignButton.closest('form')!);
  await user.click(assignButton);
  expect(form.getByRole('button', { name: 'Saving…' }).matches(':disabled')).toBe(true);
  expect(form.queryByRole('button', { name: 'Loading the latest details…' })).toBeNull();
  failed.reject(new ApiError(500, 'request_failed'));
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(form.queryByRole('button', { name: 'Loading the latest details…' })).toBeNull();
  const readyButton = form.getByRole('button', { name: 'Assign a plan' });
  expect(readyButton.matches(':disabled')).toBe(false);
  expect(client.call).toHaveBeenCalledTimes(1);
});
it('re-enables buttons after a changed membership once the member rows reload even when the members query never resolves', async () => {
  const user = userEvent.setup();
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const profileKey = ['members', id(1), membership.memberId];
  cache.setQueryData(profileKey, { status: 'active', revision: 1 });
  const memberRefetch = vi.fn(() => new Promise<never>(() => {}));
  const observer = new QueryObserver(cache, { queryKey: profileKey, queryFn: memberRefetch });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const client = start('admin', { cache });
    await user.click(await screen.findByRole('button', { name: 'Cancel membership' }));
    const refreshed = Promise.withResolvers<Membership[]>();
    vi.mocked(client.memberships).mockImplementation(query => query.memberId ? refreshed.promise : new Promise<never>(() => {}));
    vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_changed']));
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    expect(await screen.findByText('This record or the household billing date changed. Reload and review before saving.')).toBeDefined();
    const cancelButton = screen.getByRole('button', { name: 'Cancel membership' });
    expect(cancelButton.matches(':disabled')).toBe(true);
    await waitFor(() => expect(memberRefetch).toHaveBeenCalledOnce());
    refreshed.resolve([{ ...membership, revision: 2 }]);
    await waitFor(() => expect(cancelButton.matches(':disabled')).toBe(false));
    await user.click(cancelButton);
    await user.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, 'cancelMembership', { revision: 2 }, { membershipId: membership.id }));
  } finally { unsubscribe(); cache.clear(); }
});
it.each([
  { button: 'Resume', status: 'frozen', field: 'Next billing date', selector: 'input[name="date"]', value: '2026-12-01', operation: 'resumeMembership' },
  { button: 'Change price', status: 'active', field: /^Price/, selector: 'input[name="price"]', value: '50', operation: 'updateMembership' },
] as const)('closes a refused $button form while the cancelled membership reloads', async ({ button, status, field, selector, value, operation }) => {
  const client = start('admin', { row: { ...membership, status } });
  fireEvent.click(await screen.findByRole('button', { name: button }));
  const input = screen.getByLabelText(field, { selector });
  fireEvent.change(input, { target: { value } });
  const refreshed = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockReturnValue(refreshed.promise);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_cancelled']));
  save();
  expect(await screen.findByText("This membership has been cancelled, so it can't be changed.")).toBeDefined();
  expect(client.call).toHaveBeenCalledWith(operation, expect.objectContaining({ revision: 1 }), { membershipId: membership.id });
  expect(screen.queryByLabelText(field, { selector })).toBeNull();
  expect(screen.getByRole('button', { name: button }).matches(':disabled')).toBe(true);
  refreshed.resolve([{ ...membership, status: 'cancelled', cancelledAt: createdAt, revision: 2 }]);
  expect(await screen.findByText(/^Cancelled/)).toBeDefined();
  expect(screen.queryByRole('button', { name: button })).toBeNull();
});
it('explains when a membership has already been cancelled', async () => {
  const client = start('admin', { call: async () => { throw new ApiError(409, 'conflict', ['membership_cancelled']); } });
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel membership' }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
  expect(await screen.findByText("This membership has been cancelled, so it can't be changed.")).toBeDefined();
  expect(client.call).toHaveBeenCalledWith('cancelMembership', { revision: membership.revision }, { membershipId: membership.id });
});
const scheduledRow: Membership = { ...membership, scheduledPlanId: premium.id, scheduledAmountCents: premium.amountCents, scheduledInterval: 'monthly', scheduledOn: '2026-12-01' };
const cancelMembership = { open: 'Cancel membership', confirm: 'Confirm cancellation', prompt: 'Cancel this membership? The commitment date stays on record.', operation: 'cancelMembership' };
const cancelSwitch = { open: 'Cancel change', confirm: 'Confirm: cancel change', prompt: 'Cancel the scheduled change? The membership keeps its current plan and price.', operation: 'cancelMembershipSwitch' };
const statusChanged = { reason: 'membership_status', message: "This membership's status has changed. The tab now shows its current status.",
  reloaded: { ...membership, status: 'frozen' as const, frozenAt: createdAt, revision: 2 }, shown: /^Frozen/ };
const cancelled = { reason: 'membership_cancelled', message: "This membership has been cancelled, so it can't be changed.",
  reloaded: { ...membership, status: 'cancelled' as const, cancelledAt: createdAt, revision: 2 }, shown: /^Cancelled/ };
it.each([
  { ...cancelMembership, ...statusChanged }, { ...cancelMembership, ...cancelled },
  { ...cancelSwitch, ...statusChanged }, { ...cancelSwitch, ...cancelled },
])('closes a stale $open confirmation after $reason while the membership reloads', async ({ open, confirm, prompt, operation, reason, message, reloaded, shown }) => {
  const client = start('admin', { plans: [plan, premium], row: scheduledRow });
  fireEvent.click(await screen.findByRole('button', { name: open }));
  expect(screen.getByText(prompt)).toBeDefined();
  const reads = vi.mocked(client.memberships).mock.calls.length;
  const refreshed = Promise.withResolvers<Membership[]>();
  vi.mocked(client.memberships).mockReturnValue(refreshed.promise);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', [reason]));
  fireEvent.click(screen.getByRole('button', { name: confirm }));
  expect(await screen.findByText(message)).toBeDefined();
  expect(client.call).toHaveBeenCalledWith(operation, { revision: 1 }, { membershipId: membership.id });
  expect(screen.queryByText(prompt)).toBeNull();
  expect(screen.queryByRole('button', { name: confirm })).toBeNull();
  expect(vi.mocked(client.memberships).mock.calls.length).toBeGreaterThan(reads);
  refreshed.resolve([reloaded]);
  expect(await screen.findByText(shown)).toBeDefined();
  expect(screen.getByText(message)).toBeDefined();
});
it('keeps the generic refusal for a conflict without a reason', async () => {
  start('admin', { call: async () => { throw new ApiError(409, 'conflict', []); } });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '50' } });
  save();
  expect(await screen.findByText('This change could not be saved. Review your entries and try again.')).toBeDefined();
  expect(screen.getByLabelText(/^Price/)).toHaveProperty('value', '50');
});
it.each([
  { ...cancelMembership, row: { ...membership, revision: 3 } },
  { ...cancelSwitch, row: { ...scheduledRow, revision: 3 } },
])('closes a stale $open confirmation on a changed membership and retries with the reloaded revision', async ({ open, confirm, prompt, operation, row }) => {
  const client = start('admin', { plans: [plan, premium], row });
  const memberReads = () => vi.mocked(client.memberships).mock.calls.filter(([query]) => query.memberId === row.memberId).length;
  fireEvent.click(await screen.findByRole('button', { name: open }));
  expect(screen.getByText(prompt)).toBeDefined();
  const reads = memberReads();
  vi.mocked(client.memberships).mockResolvedValue([{ ...row, revision: 4, nextDueOn: '2027-01-01' }]);
  vi.mocked(client.call).mockRejectedValueOnce(new ApiError(409, 'conflict', ['membership_changed']));
  fireEvent.click(screen.getByRole('button', { name: confirm }));
  const message = 'This record or the household billing date changed. Reload and review before saving.';
  expect(await screen.findByText(message)).toBeDefined();
  expect(client.call).toHaveBeenNthCalledWith(1, operation, { revision: 3 }, { membershipId: row.id });
  expect(screen.queryByText(prompt)).toBeNull();
  expect(screen.queryByRole('button', { name: confirm })).toBeNull();
  await waitFor(() => expect(memberReads()).toBe(reads + 1));
  expect(await screen.findByText('Jan 1, 2027')).toBeDefined();
  expect(screen.getByText(message)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: open }));
  fireEvent.click(await screen.findByRole('button', { name: confirm }));
  await waitFor(() => expect(client.call).toHaveBeenNthCalledWith(2, operation, { revision: 4 }, { membershipId: row.id }));
});

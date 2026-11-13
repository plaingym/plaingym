// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
function start(role: StaffRole, options: { plans?: Plan[]; row?: Membership; call?: () => Promise<unknown>; cache?: QueryClient } = {}) {
  const data: ShellBootstrap = { gym: { id: id(1), name: 'Academy', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] }, session: { userId: id(6), displayName: 'Test User', roles: [role], member: false }, login: { password: true, magicLink: false } };
  const client = { plans: vi.fn(async () => options.plans ?? [plan]), memberships: vi.fn(async () => [options.row ?? membership]),
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
  start('admin', { call: async () => { throw new ApiError(409, 'conflict'); } });
  const form = await openEdit();
  fireEvent.change(form.price, { target: { value: '50' } });
  save();
  expect(await screen.findByText(/Reload and review before saving/)).toBeDefined();
});

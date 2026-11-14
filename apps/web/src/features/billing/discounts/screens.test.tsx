// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import type { Discount, Membership, Plan, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import { ApiError } from '../../../lib/api.js';
import { billingClient, type BillingClient } from '../catalog/api.js';
import { MembershipPanel } from '../memberships/member-tab.js';
import { CatalogPage } from '../catalog/page.js';
import { DiscountEditor } from './editor.js';
import { DiscountCatalog } from './catalog.js';
import type { DiscountClient } from './api.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0'), createdAt = '2026-11-12T12:00:00Z';
const plan: Plan = { id: id(2), createdAt, name: 'Unlimited', currency: 'USD', amountCents: 10000, interval: 'monthly', signupFeeCents: 1000,
  trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
const discount: Discount = { id: id(3), createdAt, name: 'Family offer', code: 'FAMILY', percentBasisPoints: 1250, amountCents: null,
  currency: 'USD', waivesSignupFee: true, duration: 'cycles', cycles: 3, endsOn: null, maxUses: 10, uses: 2, termsLocked: true, active: true, planIds: [plan.id], revision: 4 };
const row: Membership = { id: id(4), createdAt, memberId: id(5), householdId: id(6), planId: plan.id, status: 'active', currency: 'USD', amountCents: 10000,
  interval: 'monthly', startsOn: '2026-11-01', nextDueOn: '2026-12-01', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null,
  commitmentEndsOn: null, scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null, revision: 7,
  discount: { id: id(7), discountId: discount.id, name: discount.name, percentBasisPoints: 1250, amountCents: null, currency: 'USD', waivesSignupFee: true,
    duration: 'cycles', cyclesLeft: 2, planIds: [plan.id] } };
function clients() {
  const discounts: DiscountClient = { list: vi.fn(async () => [discount]), create: vi.fn(async () => ({ data: discount })), update: vi.fn(async () => ({ data: discount })) };
  const billing = { ...billingClient, plans: vi.fn(async () => [plan]), settings: vi.fn(async () => ({ currency: 'USD' })),
    memberships: vi.fn(async () => [row]), member: vi.fn(async () => ({ householdId: row.householdId })),
    householdBilling: vi.fn(async () => ({ billingDay: null })), call: vi.fn(async () => ({ data: row })) } as unknown as BillingClient;
  return { discounts, billing };
}
function start(view: React.ReactNode, role: StaffRole = 'owner') {
  const data: ShellBootstrap = { gym: { id: id(1), name: 'Gym', currency: 'USD', timezone: 'UTC', enabledModules: [] },
    session: { userId: id(8), displayName: 'Staff', roles: [role], member: false }, login: { password: true, magicLink: false } };
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => data)}>{view}</ShellServicesContext.Provider>
  </QueryClientProvider>);
}
function panel(role: StaffRole = 'owner', membership = row) {
  const api = clients(); vi.mocked(api.billing.memberships).mockResolvedValue([membership]);
  start(<MembershipPanel gymId={id(1)} memberId={row.memberId} manage={canStaff([role], 'plans.manage')} client={api.billing} discounts={api.discounts}/>, role);
  return api;
}
const field = (label: string | RegExp, value: string, scope = screen) => fireEvent.change(scope.getByLabelText(label), { target: { value } });
const save = () => fireEvent.submit(screen.getByRole('button', { name: 'Save discount' }).closest('form')!);
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('lists benefits, uses, eligibility, locked terms and optional inactive cards', async () => {
  const api = clients(); vi.mocked(api.discounts.list).mockResolvedValue([discount, { ...discount, id: id(9), name: 'Old offer', active: false }]);
  start(<DiscountCatalog gymId={id(1)} client={api.discounts} billing={api.billing}/>);
  expect(await screen.findByText('Uses: 2 / 10')).toBeDefined();
  expect(screen.getByText('12.5% off · Sign-up fee waived')).toBeDefined();
  expect(screen.getByText('Plans: Unlimited')).toBeDefined(); expect(screen.getByText(/Terms are locked/)).toBeDefined();
  expect(screen.queryByText('Old offer')).toBeNull(); fireEvent.click(screen.getByLabelText('Include inactive discounts'));
  expect(screen.getByText('Old offer')).toBeDefined();
});
it.each([0, 2])('disables historically used terms with %s current uses but permits metadata edits', async uses => {
  const api = clients(); start(<DiscountEditor record={{ ...discount, uses }} plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>);
  expect((screen.getByLabelText('Discount type').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
  field('Discount name', 'Renamed'); fireEvent.click(screen.getByLabelText('Active')); save();
  await waitFor(() => expect(api.discounts.update).toHaveBeenCalledWith(discount.id, {
    name: 'Renamed', code: 'FAMILY', endsOn: null, maxUses: 10, active: false, planIds: [plan.id], revision: 4,
  }));
});
it('shows the catalog terms lock even with zero current uses', async () => {
  const api = clients(); vi.mocked(api.discounts.list).mockResolvedValue([{ ...discount, uses: 0 }]);
  start(<DiscountCatalog gymId={id(1)} client={api.discounts} billing={api.billing}/>);
  expect(await screen.findByText('Uses: 0 / 10')).toBeDefined();
  expect(screen.getByText(/Terms are locked/)).toBeDefined();
});
it('allows editing the terms of a never-applied discount', async () => {
  const api = clients(); start(<DiscountEditor record={{ ...discount, uses: 0, termsLocked: false }} plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>);
  expect((screen.getByLabelText('Discount type').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
  field('Percentage (up to 100)', '20'); save();
  await waitFor(() => expect(api.discounts.update).toHaveBeenCalledWith(discount.id, expect.objectContaining({ percentBasisPoints: 2000, revision: 4 })));
});
it('creates a fixed amount in the currency minor units and preserves duration and plan selection', async () => {
  const api = clients(); start(<DiscountEditor plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>);
  field('Discount name', 'Ten off'); field('Discount type', 'amount'); field('Amount (USD)', '10.50'); field('Duration', 'cycles'); field('Number of cycles', '3');
  fireEvent.click(screen.getByLabelText(plan.name)); save();
  await waitFor(() => expect(api.discounts.create).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1050, percentBasisPoints: null, currency: 'USD', cycles: 3, duration: 'cycles', planIds: [plan.id] })));
});
it.each(['0', '100.01', '10.125', 'abc'])('rejects invalid percentage %s before transport', async value => {
  const api = clients(); start(<DiscountEditor plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>);
  field('Discount name', 'Offer'); field('Discount type', 'percent'); field('Percentage (up to 100)', value); save();
  expect(await screen.findByRole('alert')).toBeDefined(); expect(api.discounts.create).not.toHaveBeenCalled();
});
it('gives the code fields patterns browsers compile with the v flag', async () => {
  const patterns = () => [...document.querySelectorAll('input[pattern]')].map(input => input.getAttribute('pattern')!);
  const api = clients(); start(<DiscountEditor plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>);
  const found = patterns(); cleanup(); panel();
  const form = within((await screen.findByRole('button', { name: 'Assign a plan' })).closest('form')!);
  fireEvent.change(form.getByLabelText('Discount', { exact: true }), { target: { value: 'code' } });
  found.push(...patterns()); expect(found.length).toBeGreaterThanOrEqual(2);
  for (const pattern of found) expect(new RegExp('^(?:' + pattern + ')$', 'v').test('FAMILY-10')).toBe(true);
});
it('keeps a conflicted editor open and blocks resubmitting its stale revision', async () => {
  const api = clients(); vi.mocked(api.discounts.update).mockRejectedValue(new ApiError(409, 'conflict'));
  start(<DiscountEditor record={discount} plans={[plan]} currency="USD" client={api.discounts} close={vi.fn()} saved={vi.fn()}/>); save();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Close and reload'));
  expect((screen.getByRole('button', { name: 'Save discount' }) as HTMLButtonElement).disabled).toBe(true);
});
it.each(['named', 'code'])('assigns with a discount using %s selection', async mode => {
  const api = panel();
  const form = within((await screen.findByRole('button', { name: 'Assign a plan' })).closest('form')!);
  fireEvent.change(form.getByLabelText('Discount', { exact: true }), { target: { value: mode } });
  if (mode === 'named') {
    await form.findByRole('option', { name: /Family offer/ });
    fireEvent.change(form.getByLabelText('Choose a discount'), { target: { value: discount.id } });
  } else fireEvent.change(form.getByLabelText('Discount code'), { target: { value: 'fAmIlY' } });
  fireEvent.submit(form.getByRole('button', { name: 'Assign a plan' }).closest('form')!);
  await waitFor(() => expect(api.billing.call).toHaveBeenCalledWith('assignMembership', expect.objectContaining({ discount: mode === 'named' ? { discountId: discount.id } : { code: 'fAmIlY' } }), {}));
});
it.each([true, false])('replaces or adds the card discount with its revision (existing %s)', async existing => {
  const api = panel('admin', { ...row, discount: existing ? row.discount : null });
  fireEvent.click(await screen.findByRole('button', { name: existing ? 'Change discount' : 'Add discount' }));
  const form = within(screen.getByRole('button', { name: 'Apply discount' }).closest('form')!);
  fireEvent.change(form.getByLabelText('Discount'), { target: { value: 'code' } });
  fireEvent.change(form.getByLabelText('Discount code'), { target: { value: 'FAMILY' } });
  fireEvent.submit(form.getByRole('button', { name: 'Apply discount' }).closest('form')!);
  await waitFor(() => expect(api.billing.call).toHaveBeenCalledWith('setMembershipDiscount', { revision: 7, discount: { code: 'FAMILY' } }, { membershipId: row.id }));
});
it('shows cycles left and confirms removal without returning a use', async () => {
  const api = panel(); expect(await screen.findByText('Billing cycles left: 2')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Remove discount' }));
  expect(screen.getByText(/use is not returned/)).toBeDefined();
  fireEvent.submit(screen.getByRole('button', { name: 'Remove discount' }).closest('form')!);
  await waitFor(() => expect(api.billing.call).toHaveBeenCalledWith('removeMembershipDiscount', { revision: 7 }, { membershipId: row.id }));
});
it.each(['discount_used_up', 'discount_ended', 'discount_plan'])('shows a clear %s refusal in the assignment flow', async reason => {
  const api = panel(); vi.mocked(api.billing.call).mockRejectedValue(new ApiError(409, 'conflict', [reason]));
  const form = within((await screen.findByRole('button', { name: 'Assign a plan' })).closest('form')!);
  fireEvent.change(form.getByLabelText('Discount'), { target: { value: 'code' } });
  fireEvent.change(form.getByLabelText('Discount code'), { target: { value: 'FAMILY' } });
  fireEvent.submit(form.getByRole('button', { name: 'Assign a plan' }).closest('form')!);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no uses left|has ended|does not apply/));
  expect(screen.getByRole('alert').dataset.variant).toBe('error');
  expect(document.activeElement).toBe(screen.getByRole('alert'));
});
it.each(['coach', 'front_desk'] as const)('hides discount details and controls from %s', async role => {
  const api = panel(role); await screen.findByText('Dec 1, 2026');
  expect(screen.queryByText('Discount: Family offer')).toBeNull(); expect(screen.queryByRole('button', { name: 'Change discount' })).toBeNull();
  expect(screen.queryByLabelText('Discount')).toBeNull(); expect(api.discounts.list).not.toHaveBeenCalled();
  cleanup(); start(<CatalogPage/>, role); expect(await screen.findByRole('alert')).toBeDefined();
  expect(screen.queryByRole('heading', { name: 'Discounts' })).toBeNull();
});

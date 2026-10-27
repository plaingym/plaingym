// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GymSettings, Member, Plan, TaxRate, Membership } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import { ApiError } from '../../../lib/api.js';
import { CatalogWorkspace } from './page.js';
import { MembershipPanel } from '../memberships/member-tab.js';
import { registration as catalogRegistration } from './registrations.js';
import { registration as membershipRegistration } from '../memberships/registrations.js';
import type { BillingClient } from './api.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0'), createdAt = '2026-10-23T12:00:00Z';
const plan: Plan = { id: id(2), createdAt, name: 'Unlimited', currency: 'CAD', amountCents: 9999, interval: 'monthly', signupFeeCents: 2500, trialDays: 0, commitmentMonths: 6, active: true, revision: 3, taxRateIds: [id(3)] };
const tax: TaxRate = { id: id(3), createdAt, name: 'Sales tax', rateMillionths: 99_750, inclusive: false, active: true, revision: 1 };
const settings: GymSettings = { id: id(1), name: 'Gym', slug: 'gym', currency: 'CAD', timezone: 'America/Vancouver', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 7, cancellationCutoffMinutes: 0, openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], revision: 1, createdAt, updatedAt: createdAt };
const member: Member = { id: id(4), createdAt, householdId: id(5), firstName: 'Ada', lastName: 'Student', email: null, phone: null, photoKey: null, dateOfBirth: null,
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1 };
const membership: Membership = { id: id(6), createdAt, memberId: member.id, householdId: member.householdId, planId: plan.id, status: 'active', currency: 'CAD', amountCents: 9999,
  interval: 'monthly', startsOn: '2026-10-01', nextDueOn: '2026-10-31', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: '2027-04-01', revision: 2 };
function client() {
  return { plans: vi.fn(async () => [plan]), taxes: vi.fn(async () => [tax]), charges: vi.fn(async () => []), settings: vi.fn(async () => settings), member: vi.fn(async () => member), householdBilling: vi.fn(async () => ({ id: member.householdId, billingDay: 31, familyDiscountBasisPoints: 0, revision: 1 })),
    memberships: vi.fn(async () => [membership]), call: vi.fn(async () => ({ data: plan })) as unknown as BillingClient['call'] } satisfies BillingClient;
}
function start(view: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ShellServicesContext.Provider value={createShellServices(async () => ({ gym: { id: id(1), name: 'Gym', timezone: settings.timezone, currency: settings.currency, enabledModules: [] }, session: { userId: id(9), roles: ['admin'], member: false }, login: { password: true, magicLink: false } }))}>{view}</ShellServicesContext.Provider></QueryClientProvider>);
}
afterEach(cleanup);
describe('catalog and member billing screens', () => {
  it('registers the catalog and membership tab', () => {
    expect(catalogRegistration.adminNav?.[0]).toMatchObject({ enabled: true, href: '/admin/billing/plans' });
    expect(membershipRegistration.memberTabs?.[0]).toMatchObject({ enabled: true });
  });
  it('edits the catalog with read revisions and exact cents', async () => {
    const api = client(); start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    fireEvent.change(screen.getByLabelText('Amount (CAD)'), { target: { value: '100.29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updatePlan', expect.objectContaining({ amountCents: 10029, revision: 3, taxRateIds: [tax.id] }), { planId: plan.id }));
  });
  it('keeps the catalog draft visible on a conflict', async () => {
    const api = client(); vi.mocked(api.call).mockRejectedValue(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My changed plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My changed plan');
  });
  it('creates an inclusive tax rate and shows an empty charge catalog', async () => {
    const api = client(); start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tax rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Tax rates' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'QST' } });
    fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '9.975' } });
    fireEvent.click(screen.getByLabelText('Tax included'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('createTaxRate', expect.objectContaining({ rateMillionths: 99750, inclusive: true }), {}));
    fireEvent.click(screen.getByRole('button', { name: 'Charge types' }));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
  });
  it('offers proration by default and sends the selected first-period choice', async () => {
    const api = client(); start(<MembershipPanel gymId={id(1)} memberId={member.id} manage client={api} now={new Date(createdAt)}/>);
    await screen.findByLabelText('First period');
    expect((screen.getByLabelText('First period') as HTMLSelectElement).value).toBe('prorate_now');
    expect((screen.getByLabelText('Next billing date') as HTMLInputElement).value).toBe('2026-10-31');
    fireEvent.change(screen.getByLabelText('First period'), { target: { value: 'next_billing_date' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign a plan' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('assignMembership', expect.objectContaining({ memberId: member.id, householdId: member.householdId, planId: plan.id, firstPeriod: 'next_billing_date' }), {}));
  });
  it('moves the suggested billing date with the start date', async () => {
    const api = client(); start(<MembershipPanel gymId={id(1)} memberId={member.id} manage client={api} now={new Date(createdAt)}/>);
    const due = await screen.findByLabelText('Next billing date') as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2026-11-05' } });
    expect(due.value).toBe('2026-11-30');
    fireEvent.change(due, { target: { value: '2026-12-31' } });
    expect(due.value).toBe('2026-12-31');
  });
  it('freezes with a nullable resume date and the membership read revision', async () => {
    const api = client(); start(<MembershipPanel gymId={id(1)} memberId={member.id} manage client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('freezeMembership', { revision: 2, resumesOn: null }, { membershipId: membership.id }));
  });
  it('requires confirmation to cancel and leaves actions hidden from front desk', async () => {
    const api = client(); const view = start(<MembershipPanel gymId={id(1)} memberId={member.id} manage client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel membership' }));
    expect(api.call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancellation' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('cancelMembership', { revision: 2 }, { membershipId: membership.id }));
    view.unmount(); const desk = client(); start(<MembershipPanel gymId={id(1)} memberId={member.id} manage={false} client={desk}/>);
    await screen.findByText('2026-10-31');
    expect(screen.queryByRole('button', { name: 'Freeze' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Assign a plan' })).toBeNull();
    expect(desk.settings).not.toHaveBeenCalled();
  });
  it('renders loading and retryable errors', async () => {
    const api = client(); vi.mocked(api.plans).mockRejectedValue(new Error('Unavailable'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    expect(screen.getByRole('status')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

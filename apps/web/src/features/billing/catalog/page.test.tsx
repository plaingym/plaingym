// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChargeType, GymSettings, Member, Plan, TaxRate, TaxRateUsage, Membership } from '@plaingym/shared/contracts';
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
  bookingWindowDays: 7, cancellationCutoffMinutes: 0, openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 1, createdAt, updatedAt: createdAt };
const member: Member = { id: id(4), createdAt, householdId: id(5), firstName: 'Ada', lastName: 'Student', email: null, phone: null, photoKey: null, dateOfBirth: null,
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1 };
const membership: Membership = { id: id(6), createdAt, memberId: member.id, householdId: member.householdId, planId: plan.id, status: 'active', currency: 'CAD', amountCents: 9999,
  interval: 'monthly', startsOn: '2026-10-01', nextDueOn: '2026-10-31', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: '2027-04-01', revision: 2 };
function client() {
  return { plans: vi.fn(async () => [plan]), taxes: vi.fn(async () => [tax]), charges: vi.fn(async (): Promise<ChargeType[]> => []), settings: vi.fn(async () => settings), member: vi.fn(async () => member), householdBilling: vi.fn(async () => ({ id: member.householdId, billingDay: 31, familyDiscountBasisPoints: 0, revision: 1 })),
    memberships: vi.fn(async () => [membership]), call: vi.fn(async () => ({ data: plan })) as unknown as BillingClient['call'] } satisfies BillingClient;
}
function start(view: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><ShellServicesContext.Provider value={createShellServices(async () => ({ gym: { id: id(1), name: 'Gym', timezone: settings.timezone, currency: settings.currency, enabledModules: [] }, session: { userId: id(9), displayName: 'Test User', roles: ['admin'], member: false }, login: { password: true, magicLink: false } }))}>{view}</ShellServicesContext.Provider></QueryClientProvider>);
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
  it('shows and takes a zero-decimal gym\'s prices in whole yen', async () => {
    const api = client(), yen = { ...plan, currency: 'JPY', amountCents: 12000, signupFeeCents: 5500 };
    api.plans.mockResolvedValue([yen]); api.settings.mockResolvedValue({ ...settings, currency: 'JPY' });
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    expect(await screen.findByText(/¥12,000/)).toBeTruthy(); expect(screen.getByText(/¥5,500/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Unlimited' }));
    const amount = screen.getByLabelText('Amount (JPY)') as HTMLInputElement, fee = screen.getByLabelText('Sign-up fee (JPY)') as HTMLInputElement;
    expect([amount.value, amount.step, fee.value]).toEqual(['12000', '1', '5500']);
    fireEvent.change(amount, { target: { value: '2500.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    // The step attribute refuses a fraction of a yen before the form submits.
    expect(amount.checkValidity()).toBe(false); expect(api.call).not.toHaveBeenCalled();
    fireEvent.change(amount, { target: { value: '2500' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updatePlan', expect.objectContaining({ amountCents: 2500, signupFeeCents: 5500, currency: 'JPY' }), { planId: plan.id }));
  });
  it('takes a three-decimal gym\'s prices in fils', async () => {
    const api = client(), dinar = { ...plan, currency: 'KWD', amountCents: 12500, signupFeeCents: 0 };
    api.plans.mockResolvedValue([dinar]); api.settings.mockResolvedValue({ ...settings, currency: 'KWD' });
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    const amount = screen.getByLabelText('Amount (KWD)') as HTMLInputElement;
    expect([amount.value, amount.step]).toEqual(['12.50', '0.01']);
    fireEvent.change(amount, { target: { value: '7.25' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updatePlan', expect.objectContaining({ amountCents: 7250, currency: 'KWD' }), { planId: plan.id }));
  });
  it('keeps the open record on its read revision until a reload', async () => {
    const api = client(); start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    const edit = screen.getByRole('button', { name: 'Edit Unlimited' }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Reload record' });
    expect(edit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(edit.disabled).toBe(false);
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
  const charge: ChargeType = { id: id(7), createdAt, name: 'Drop-in', currency: 'CAD', amountCents: 2000, active: true, revision: 4, taxRateIds: [tax.id] };
  it.each([
    { section: 'Plans', record: plan, operation: 'updatePlan', parameter: 'planId' },
    { section: 'Charge types', record: charge, operation: 'updateChargeType', parameter: 'chargeTypeId' },
    { section: 'Tax rates', record: tax, operation: 'updateTaxRate', parameter: 'taxRateId' },
  ])('reloads a stale $section editor and saves with the fresh revision', async ({ section, record, operation, parameter }) => {
    const api = client(); api.charges.mockResolvedValue([charge]);
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: section }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit ' + record.name }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Staff draft' } });
    if ('amountCents' in record) {
      fireEvent.change(screen.getByLabelText('Amount (CAD)'), { target: { value: '40.29' } });
    } else fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '8.25' } });
    // Another staff member changes untouched fields while this editor is open.
    api.plans.mockResolvedValue([{ ...plan, revision: plan.revision + 1, interval: 'annual', active: false }]);
    api.charges.mockResolvedValue([{ ...charge, revision: charge.revision + 1, active: false }]);
    api.taxes.mockResolvedValue([{ ...tax, revision: tax.revision + 1, inclusive: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: 'Reload record' });
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(api.plans.mock.calls.length).toBeGreaterThan(1));
    // Edits made after the failed save also survive the reload.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Staff draft after conflict' } });
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull());
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Staff draft after conflict');
    expect((screen.getByLabelText('Active') as HTMLInputElement).checked).toBe(section === 'Tax rates');
    if (section === 'Plans') expect((screen.getByLabelText('Billing interval') as HTMLSelectElement).value).toBe('annual');
    if (section === 'Tax rates') expect((screen.getByLabelText('Tax included') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith(operation, expect.objectContaining({
      revision: record.revision + 1, name: 'Staff draft after conflict',
      ...('amountCents' in record ? { amountCents: 4029, active: false } : { rateMillionths: 82500, inclusive: true }),
    }), { [parameter]: record.id }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });
  it('retains a draft and offers another reload when reloading fails', async () => {
    const api = client(); vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: 'Reload record' });
    api.plans.mockRejectedValueOnce(new Error('Offline'));
    fireEvent.click(reload);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Reload record' }) as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My draft');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    api.plans.mockResolvedValue([{ ...plan, revision: 4 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Reload record' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('updatePlan', expect.objectContaining({ revision: 4, name: 'My draft' }), { planId: plan.id }));
  });
  it('keeps a removed record draft without allowing another stale save', async () => {
    const api = client(); vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My draft' } });
    api.plans.mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload record' }));
    expect(await screen.findByText(/This record is no longer in the catalog/)).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('My draft');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.call).toHaveBeenCalledTimes(1);
  });
  it('drops tax selections that no longer apply, retains applicable edits and reloads untouched fields', async () => {
    const api = client(), extra = { ...tax, id: id(10), name: 'Extra tax' };
    api.taxes.mockResolvedValue([tax, extra]);
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    fireEvent.click(screen.getByLabelText('Extra tax (9.975%, Tax added)'));
    fireEvent.change(screen.getByLabelText('Commitment (months, optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText('Active', { exact: true }));
    api.taxes.mockResolvedValue([{ ...tax, active: false }, extra]);
    api.plans.mockResolvedValue([{ ...plan, revision: 4, taxRateIds: [], signupFeeCents: 3500, trialDays: 7 }]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const reload = await screen.findByRole('button', { name: 'Reload record' });
    // An invalid field edited after the conflict must survive too.
    fireEvent.change(screen.getByLabelText('Amount (CAD)'), { target: { value: '' } });
    fireEvent.click(reload);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull());
    expect((screen.getByLabelText('Amount (CAD)') as HTMLInputElement).value).toBe('');
    expect(screen.queryByLabelText(/Sales tax/)).toBeNull();
    expect((screen.getByLabelText('Extra tax (9.975%, Tax added)') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Sign-up fee (CAD)') as HTMLInputElement).value).toBe('35.00');
    expect((screen.getByLabelText('Trial days') as HTMLInputElement).value).toBe('7');
    fireEvent.change(screen.getByLabelText('Amount (CAD)'), { target: { value: '10.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('updatePlan', expect.objectContaining({
      revision: 4, taxRateIds: [extra.id], active: false, signupFeeCents: 3500, trialDays: 7, commitmentMonths: null,
    }), { planId: plan.id }));
  });
  it('merges tax selections rate by rate on a reload', async () => {
    const api = client(), extra = { ...tax, id: id(10), name: 'Extra tax' }, third = { ...tax, id: id(11), name: 'Third tax' }, fourth = { ...tax, id: id(12), name: 'Fourth tax' };
    api.taxes.mockResolvedValue([tax, extra, third, fourth]);
    api.plans.mockResolvedValue([{ ...plan, taxRateIds: [tax.id, extra.id] }]);
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Unlimited' }));
    const box = (name: string) => screen.getByLabelText(name + ' (9.975%, Tax added)') as HTMLInputElement;
    // Unticking and reticking only reorders the draft: it is not a change to the rate.
    fireEvent.click(box('Sales tax')); fireEvent.click(box('Sales tax'));
    fireEvent.click(box('Extra tax')); fireEvent.click(box('Third tax'));
    // Another staff member adds a rate this draft never touched.
    api.plans.mockResolvedValue([{ ...plan, revision: 4, taxRateIds: [tax.id, extra.id, fourth.id] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reload record' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull());
    expect([box('Sales tax').checked, box('Extra tax').checked, box('Third tax').checked, box('Fourth tax').checked]).toEqual([true, false, true, true]);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('updatePlan',
      expect.objectContaining({ revision: 4, taxRateIds: [tax.id, third.id, fourth.id] }), { planId: plan.id }));
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
  const usage: TaxRateUsage = { chargeTypes: [{ id: id(7), name: 'Drop-in', active: true }],
    plans: [{ id: plan.id, name: 'Unlimited', active: true, memberships: 3 }, { id: id(8), name: 'Retired plan', active: false, memberships: 0 }], memberships: 3 };
  function answering(api: ReturnType<typeof client>, found: TaxRateUsage) {
    vi.mocked(api.call).mockImplementation((async (name: string) => name === 'getTaxRateUsage' ? { data: found } : { data: tax }) as unknown as BillingClient['call']);
  }
  async function archiveFromEditor(api: ReturnType<typeof client>) {
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tax rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sales tax' }));
    fireEvent.click(screen.getByLabelText('Active'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  }
  it('shows what carries a tax rate and the memberships affected before archiving it', async () => {
    const api = client(); answering(api, usage); await archiveFromEditor(api);
    const confirm = await screen.findByRole('button', { name: 'Remove and archive — items: 3' });
    expect(api.call).toHaveBeenCalledWith('getTaxRateUsage', undefined, { taxRateId: tax.id });
    expect(api.call).not.toHaveBeenCalledWith('updateTaxRate', expect.anything(), expect.anything());
    const panel = screen.getByRole('region', { name: 'Archive Sales tax?' });
    expect(panel.textContent).toContain('Drop-in');
    expect(panel.textContent).toContain('Unlimited — current memberships: 3');
    expect(panel.textContent).toContain('Retired plan — current memberships: 0 (Inactive)');
    expect(screen.getByRole('note').textContent).toBe('Current memberships on these plans: 3. Their next invoices no longer add this tax.');
    fireEvent.click(confirm);
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateTaxRate',
      expect.objectContaining({ revision: 1, name: 'Sales tax', active: false, detach: true }), { taxRateId: tax.id }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Archive Sales tax?' })).toBeNull());
  });
  it('cancels the archive confirmation without saving and keeps the draft', async () => {
    const api = client(); answering(api, usage); await archiveFromEditor(api);
    const panel = await screen.findByRole('region', { name: 'Archive Sales tax?' });
    // The draft is held while the confirmation is open, so it confirms what is on screen.
    expect(screen.getByLabelText('Name').matches(':disabled')).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: 'Archive Sales tax?' })).toBeNull();
    expect(screen.getByLabelText('Name').matches(':disabled')).toBe(false);
    expect((screen.getByLabelText('Active') as HTMLInputElement).checked).toBe(false);
    expect(api.call).not.toHaveBeenCalledWith('updateTaxRate', expect.anything(), expect.anything());
  });
  it('archives a tax rate nothing carries without asking', async () => {
    const api = client(); answering(api, { chargeTypes: [], plans: [], memberships: 0 }); await archiveFromEditor(api);
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateTaxRate', expect.objectContaining({ revision: 1, active: false }), { taxRateId: tax.id }));
    expect(vi.mocked(api.call).mock.calls.find(call => call[0] === 'updateTaxRate')?.[1]).not.toHaveProperty('detach');
    expect(screen.queryByRole('region')).toBeNull();
  });
  it('closes the confirmation and reloads when the rate changed before confirming', async () => {
    const api = client(); answering(api, usage); await archiveFromEditor(api);
    const confirm = await screen.findByRole('button', { name: 'Remove and archive — items: 3' });
    const loads = vi.mocked(api.taxes).mock.calls.length;
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    fireEvent.click(confirm);
    expect((await screen.findByRole('alert')).textContent).toContain('Reload and review before saving.');
    expect(screen.queryByRole('region', { name: 'Archive Sales tax?' })).toBeNull();
    await waitFor(() => expect(vi.mocked(api.taxes).mock.calls.length).toBeGreaterThan(loads));
    vi.mocked(api.taxes).mockResolvedValue([{ ...tax, revision: 2, inclusive: true }]);
    fireEvent.click(screen.getByRole('button', { name: 'Reload record' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull());
    expect((screen.getByLabelText('Active') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Tax included') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const panel = await screen.findByRole('region', { name: 'Archive Sales tax?' });
    fireEvent.click(within(panel).getByRole('button', { name: /Remove and archive/ }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('updateTaxRate',
      expect.objectContaining({ revision: 2, active: false, inclusive: true, detach: true }), { taxRateId: tax.id }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).toBeNull());
  });
  it('shows the confirmation when something attached the rate after the check', async () => {
    const api = client(); let found: TaxRateUsage = { chargeTypes: [], plans: [], memberships: 0 };
    vi.mocked(api.call).mockImplementation((async (name: string) => {
      if (name === 'getTaxRateUsage') return { data: found };
      found = usage; throw new ApiError(409, 'conflict', ['tax_rate_attached']);
    }) as unknown as BillingClient['call']);
    await archiveFromEditor(api);
    expect(await screen.findByRole('region', { name: 'Archive Sales tax?' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each([{ reason: [] }, { reason: ['tax_rate_inactive'] }])('keeps a stale or unrelated conflict out of the archive panel (reason: $reason)', async ({ reason }) => {
    const api = client(); let found: TaxRateUsage = { chargeTypes: [], plans: [], memberships: 0 };
    vi.mocked(api.call).mockImplementation((async (name: string) => {
      if (name === 'getTaxRateUsage') return { data: found };
      found = usage; throw new ApiError(409, 'conflict', reason);
    }) as unknown as BillingClient['call']);
    await archiveFromEditor(api);
    expect((await screen.findByRole('alert')).textContent).toContain('Reload and review before saving.');
    expect(screen.queryByRole('region', { name: 'Archive Sales tax?' })).toBeNull();
    expect(vi.mocked(api.call).mock.calls.filter(call => call[0] === 'getTaxRateUsage')).toHaveLength(1);
    expect((screen.getByLabelText('Active') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByLabelText('Name').matches(':disabled')).toBe(false);
  });
  it('uses label-and-number counts for one affected item and membership', async () => {
    const api = client(); answering(api, { chargeTypes: [], plans: [{ id: plan.id, name: 'Unlimited', active: true, memberships: 1 }], memberships: 1 });
    await archiveFromEditor(api);
    const panel = await screen.findByRole('region', { name: 'Archive Sales tax?' });
    expect(within(panel).getByRole('button', { name: 'Remove and archive — items: 1' })).toBeTruthy();
    expect(panel.textContent).toContain('Unlimited — current memberships: 1');
    expect(within(panel).getByRole('note').textContent).toContain('Current memberships on these plans: 1.');
  });
  it('edits a rate archived before the detach rule without asking', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]); answering(api, usage);
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tax rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sales tax' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Old sales tax' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateTaxRate', expect.objectContaining({ revision: 2, name: 'Old sales tax', active: false }), { taxRateId: tax.id }));
    expect(api.call).not.toHaveBeenCalledWith('getTaxRateUsage', undefined, expect.anything());
  });
  it('warns on a plan carrying an archived tax rate and removes it', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]);
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    expect((await screen.findByRole('note')).textContent).toContain('This plan carries an inactive tax rate (Sales tax). Its invoices still add it until you remove it.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Unlimited' }));
    expect(screen.getByLabelText('Sales tax (9.975%, Tax added, Inactive)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove inactive tax rates from Unlimited' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updatePlan', { revision: 3, taxRateIds: [] }, { planId: plan.id }));
  });
  it('refreshes the catalog when removing an archived tax rate conflicts, so a retry uses the fresh revision', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]);
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    const remove = await screen.findByRole('button', { name: 'Remove inactive tax rates from Unlimited' });
    api.plans.mockResolvedValue([{ ...plan, revision: 4 }]);
    fireEvent.click(remove);
    expect((await screen.findByRole('alert')).textContent).toContain('Reload and review before saving.');
    await waitFor(() => expect(api.plans.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Remove inactive tax rates from Unlimited' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Remove inactive tax rates from Unlimited' }));
    await waitFor(() => expect(api.call).toHaveBeenLastCalledWith('updatePlan', { revision: 4, taxRateIds: [] }, { planId: plan.id }));
  });
  it('warns on a charge type carrying an archived tax rate', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]);
    const charge: ChargeType = { id: id(7), createdAt, name: 'Drop-in', currency: 'CAD', amountCents: 2000, active: true, revision: 4, taxRateIds: [tax.id] };
    vi.mocked(api.charges).mockResolvedValue([charge]);
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Charge types' }));
    expect(screen.getByRole('note').textContent).toContain('One-off invoices for it are refused until you remove it.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove inactive tax rates from Drop-in' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateChargeType', { revision: 4, taxRateIds: [] }, { chargeTypeId: charge.id }));
  });
  it('offers to remove an archived tax rate from everything still carrying it', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]); answering(api, usage);
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tax rates' }));
    expect(screen.getByRole('note').textContent).toContain('Inactive. Charge types and plans still carrying it: 1.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sales tax from them' }));
    const panel = await screen.findByRole('region', { name: 'Remove Sales tax from these items?' });
    expect(panel.textContent).toContain('This tax rate is inactive. Remove it from the charge types and plans that still carry it.');
    expect(panel.textContent).not.toContain('Archiving');
    expect(screen.queryByRole('region', { name: 'Archive Sales tax?' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove from items: 3' }));
    await waitFor(() => expect(api.call).toHaveBeenCalledWith('updateTaxRate', { revision: 2, active: false, detach: true }, { taxRateId: tax.id }));
  });
  it('keeps a new record saveable when an archive confirmation opened over it conflicts', async () => {
    const api = client(), archived = { ...tax, active: false, revision: 2 }; vi.mocked(api.taxes).mockResolvedValue([archived]);
    let answer = (_: { data: TaxRateUsage }) => {};
    vi.mocked(api.call).mockImplementationOnce(() => new Promise(resolve => { answer = resolve as typeof answer; }));
    start(<CatalogWorkspace gymId={id(1)} client={api}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Tax rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sales tax from them' }));
    // The Add button stays open while the usage check is in flight.
    fireEvent.click(await screen.findByRole('button', { name: 'Add Tax rates' }));
    answer({ data: usage });
    const panel = await screen.findByRole('region', { name: 'Remove Sales tax from these items?' });
    vi.mocked(api.call).mockRejectedValueOnce(new ApiError(409, 'conflict'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove from items: 3' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Remove Sales tax from these items?' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Reload record' })).toBeNull();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false));
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

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Membership, MembershipSwitchPreview, Plan, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { ApiError } from '../../../lib/api.js';
import { createShellServices } from '../../../app/services.js';
import type { BillingClient } from '../catalog/api.js';
import { MembershipPanel } from './member-tab.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-10-27T00:30:00Z';
const plan: Plan = { id: id(2), createdAt, name: 'Unlimited classes', currency: 'CAD', amountCents: 10000, interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
const premium: Plan = { ...plan, id: id(7), name: 'Premium', amountCents: 15000 };
const basic: Plan = { ...plan, id: id(8), name: 'Basic', amountCents: 6000 };
const membership: Membership = { id: id(3), createdAt, memberId: id(4), householdId: id(5), planId: plan.id, status: 'active', currency: 'CAD', amountCents: 10000, interval: 'monthly', startsOn: '2026-10-01', nextDueOn: '2026-11-01', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: null,
  scheduledPlanId: null, scheduledAmountCents: null, scheduledInterval: null, scheduledOn: null, revision: 3 };
const upgrade: MembershipSwitchPreview = { planId: premium.id, timing: 'next_billing_date', kind: 'upgrade', currency: 'CAD', priceStartsOn: '2026-11-01', commitmentBlocks: false, proration: null };
type Handler = (input: unknown, params: Record<string, string>, query: Record<string, string | number | undefined>) => Promise<unknown>;
function start(options: { plans?: Plan[]; row?: Membership; preview?: (query: Record<string, string | number | undefined>) => MembershipSwitchPreview; switchPlan?: Handler; cancel?: Handler } = {}) {
  const data: ShellBootstrap = { gym: { id: id(1), name: 'Academy', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] }, session: { userId: id(6), displayName: 'Test User', roles: ['admin'], member: false }, login: { password: true, magicLink: false } };
  const row = options.row ?? membership;
  const call = vi.fn(async (name: string, input: unknown, params: Record<string, string>, query: Record<string, string | number | undefined>) => {
    if (name === 'previewMembershipSwitch') return { data: (options.preview ?? (() => upgrade))(query) };
    if (name === 'switchMembershipPlan') return options.switchPlan ? options.switchPlan(input, params, query) : { data: { membership: row, invoiceId: null } };
    if (name === 'cancelMembershipSwitch') return options.cancel ? options.cancel(input, params, query) : { data: row };
    throw new Error('Unexpected call ' + name);
  });
  const client = { plans: vi.fn(async () => options.plans ?? [plan, premium]), memberships: vi.fn(async () => [row]), call,
    member: vi.fn(async () => ({ householdId: row.householdId })), householdBilling: vi.fn(async () => ({ billingDay: null })) } as unknown as BillingClient;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ShellServicesContext.Provider value={createShellServices(async () => data)}>
      <MembershipPanel gymId={data.gym.id} memberId={row.memberId} manage client={client} now={new Date(createdAt)}/>
    </ShellServicesContext.Provider>
  </QueryClientProvider>);
  return { client, call };
}
afterEach(cleanup);
async function openDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'Change plan' }));
  return within(await screen.findByRole('dialog'));
}
const calls = (call: ReturnType<typeof start>['call'], name: string) => call.mock.calls.filter(item => item[0] === name);

it('preselects the next billing date and previews the switch', async () => {
  const { call } = start();
  const dialog = await openDialog();
  expect((dialog.getByRole('radio', { name: /next billing date/ }) as HTMLInputElement).checked).toBe(true);
  expect((dialog.getByRole('radio', { name: 'Now' }) as HTMLInputElement).disabled).toBe(false);
  expect(await dialog.findByText(/starts on 2026-11-01/)).toBeDefined();
  expect(calls(call, 'previewMembershipSwitch')[0]!.slice(1)).toEqual([undefined, { membershipId: membership.id }, { planId: premium.id, timing: 'next_billing_date' }]);
});
it('lists only other active plans in the membership currency', async () => {
  start({ plans: [plan, premium, { ...basic, active: false }, { ...basic, id: id(9), currency: 'USD' }] });
  const dialog = await openDialog();
  const options = within(dialog.getByLabelText('New plan')).getAllByRole('option');
  expect(options.map(option => option.textContent)).toEqual([expect.stringContaining('Premium')]);
});
it('disables now for another billing interval and says why', async () => {
  start({ plans: [plan, { ...premium, interval: 'annual' }] });
  const dialog = await openDialog();
  expect((dialog.getByRole('radio', { name: 'Now' }) as HTMLInputElement).disabled).toBe(true);
  expect(dialog.getByText('A plan with another billing interval starts on a billing date.')).toBeDefined();
});
it('disables now for a frozen membership', async () => {
  start({ row: { ...membership, status: 'frozen', frozenAt: createdAt } });
  const dialog = await openDialog();
  expect((dialog.getByRole('radio', { name: 'Now' }) as HTMLInputElement).disabled).toBe(true);
  expect(dialog.getByText('Only an active membership can change plan now.')).toBeDefined();
  expect(await dialog.findByText('The change applies when the membership is next billed as active.')).toBeDefined();
});
it('shows the amount charged now and the days it covers for an upgrade now', async () => {
  const proration = { periodStartsOn: '2026-10-01', periodEndsOn: '2026-11-01', billedDays: 6, periodDays: 31, totalCents: 4839 };
  const { call } = start({ preview: query => ({ ...upgrade, timing: query.timing as 'now', priceStartsOn: '2026-10-26', ...(query.timing === 'now' ? { proration } : {}) }) });
  const dialog = await openDialog();
  fireEvent.click(dialog.getByRole('radio', { name: 'Now' }));
  expect(await dialog.findByText(/invoice for .*48\.39.* 6 of 31 days/)).toBeDefined();
  expect(dialog.getByText(/starts today \(2026-10-26\)/)).toBeDefined();
  await waitFor(() => expect(calls(call, 'previewMembershipSwitch').at(-1)![3]).toEqual({ planId: premium.id, timing: 'now' }));
});
it('says a downgrade now keeps the current price until the next billing date', async () => {
  start({ plans: [plan, basic], preview: query => ({ ...upgrade, planId: basic.id, kind: 'downgrade', timing: query.timing as 'now' }) });
  const dialog = await openDialog();
  fireEvent.click(dialog.getByRole('radio', { name: 'Now' }));
  expect(await dialog.findByText(/keeps its current price until 2026-11-01/)).toBeDefined();
});
it('asks for a reason only when the commitment blocks the switch', async () => {
  const { call } = start({ plans: [plan, basic], row: { ...membership, commitmentEndsOn: '2027-10-01' },
    preview: () => ({ ...upgrade, planId: basic.id, kind: 'downgrade', commitmentBlocks: true }) });
  const dialog = await openDialog();
  const reason = await dialog.findByLabelText('Reason for switching before the commitment ends');
  expect(dialog.getByText(/commitment runs until 2027-10-01/)).toBeDefined();
  const submit = dialog.getByRole('button', { name: 'Change plan' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: '   ' } });
  expect(submit.disabled).toBe(true);
  fireEvent.change(reason, { target: { value: ' Moving away ' } });
  fireEvent.click(submit);
  await waitFor(() => expect(calls(call, 'switchMembershipPlan')).toHaveLength(1));
  expect(calls(call, 'switchMembershipPlan')[0]![1]).toMatchObject({ revision: 3, planId: basic.id, timing: 'next_billing_date', override: { reason: 'Moving away' } });
});
it('sends no reason and no field for it when the commitment does not block', async () => {
  const { call } = start();
  const dialog = await openDialog();
  await dialog.findByText(/starts on 2026-11-01/);
  expect(dialog.queryByLabelText('Reason for switching before the commitment ends')).toBeNull();
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  await waitFor(() => expect(calls(call, 'switchMembershipPlan')).toHaveLength(1));
  const input = calls(call, 'switchMembershipPlan')[0]![1] as Record<string, unknown>;
  expect(Object.keys(input).sort()).toEqual(['planId', 'requestId', 'revision', 'timing']);
  expect(await screen.findByText('Plan changed.')).toBeDefined();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
it('mentions the invoice when an upgrade now issued one', async () => {
  start({ switchPlan: async () => ({ data: { membership, invoiceId: id(20) } }) });
  const dialog = await openDialog();
  await dialog.findByText(/starts on/);
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  expect(await screen.findByText('Plan changed. An invoice for the difference was issued.')).toBeDefined();
});
it('reuses the request ID when a failed submission is retried', async () => {
  let attempts = 0;
  const { call } = start({ switchPlan: async () => { if (++attempts === 1) throw new ApiError(500, 'request_failed'); return { data: { membership, invoiceId: null } }; } });
  const dialog = await openDialog();
  await dialog.findByText(/starts on/);
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  expect(await dialog.findByText('Could not change the plan. Please try again.')).toBeDefined();
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  await waitFor(() => expect(calls(call, 'switchMembershipPlan')).toHaveLength(2));
  const [first, second] = calls(call, 'switchMembershipPlan').map(item => (item[1] as { requestId: string }).requestId);
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(second).toBe(first);
});
it('reloads the membership and says it changed on a stale revision', async () => {
  const { client } = start({ switchPlan: async () => { throw new ApiError(409, 'conflict'); } });
  const dialog = await openDialog();
  await dialog.findByText(/starts on/);
  const before = vi.mocked(client.memberships).mock.calls.length;
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  expect(await dialog.findByText('This membership changed. It has been reloaded; review it and try again.')).toBeDefined();
  await waitFor(() => expect(vi.mocked(client.memberships).mock.calls.length).toBeGreaterThan(before));
});
it('explains a refusal by its reason code', async () => {
  start({ switchPlan: async () => { throw new ApiError(409, 'conflict', ['plan_inactive']); } });
  const dialog = await openDialog();
  await dialog.findByText(/starts on/);
  fireEvent.click(dialog.getByRole('button', { name: 'Change plan' }));
  expect(await dialog.findByText('That plan is no longer active.')).toBeDefined();
});
it('offers no submit when the preview is refused', async () => {
  const { call } = start();
  call.mockImplementation(async (name: string) => { if (name === 'previewMembershipSwitch') throw new ApiError(409, 'conflict', ['period_not_billed']); return { data: membership }; });
  const dialog = await openDialog();
  expect(await dialog.findByText(/hasn't been billed/)).toBeDefined();
  expect((dialog.getByRole('button', { name: 'Change plan' }) as HTMLButtonElement).disabled).toBe(true);
});
it('drops "now" for a plan that blocks it and does not bring it back with the next plan', async () => {
  start({ plans: [plan, premium, { ...basic, interval: 'annual' }] });
  const dialog = await openDialog();
  fireEvent.click(dialog.getByRole('radio', { name: 'Now' }));
  expect((dialog.getByRole('radio', { name: 'Now' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(dialog.getByLabelText('New plan'), { target: { value: basic.id } });
  fireEvent.change(dialog.getByLabelText('New plan'), { target: { value: premium.id } });
  expect((dialog.getByRole('radio', { name: 'Now' }) as HTMLInputElement).checked).toBe(false);
  expect((dialog.getByRole('radio', { name: /next billing date/ }) as HTMLInputElement).checked).toBe(true);
});
it('retries a preview that failed', async () => {
  let attempts = 0;
  start({ preview: () => { if (++attempts === 1) throw new ApiError(500, 'request_failed'); return upgrade; } });
  const dialog = await openDialog();
  expect(await dialog.findByText('Could not change the plan. Please try again.')).toBeDefined();
  expect((dialog.getByRole('button', { name: 'Change plan' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(dialog.getByRole('button', { name: 'Try again' }));
  expect(await dialog.findByText(/starts on 2026-11-01/)).toBeDefined();
  expect((dialog.getByRole('button', { name: 'Change plan' }) as HTMLButtonElement).disabled).toBe(false);
});
it('shows a scheduled plan change on the card and cancels it after a confirmation', async () => {
  const row = { ...membership, scheduledPlanId: premium.id, scheduledAmountCents: 15000, scheduledInterval: 'monthly' as const, scheduledOn: '2026-11-01' };
  const { call } = start({ row });
  expect(await screen.findByText(/^Changes to Premium on 2026-11-01 \(.*150\.00 \/ Monthly\)\.$/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel change' }));
  expect(calls(call, 'cancelMembershipSwitch')).toHaveLength(0);
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm: cancel change' }));
  await waitFor(() => expect(calls(call, 'cancelMembershipSwitch')).toHaveLength(1));
  expect(calls(call, 'cancelMembershipSwitch')[0]!.slice(1, 3)).toEqual([{ revision: 3 }, { membershipId: membership.id }]);
});
it('shows a scheduled price change beside the price form', async () => {
  const row = { ...membership, scheduledPlanId: plan.id, scheduledAmountCents: 8000, scheduledInterval: 'monthly' as const, scheduledOn: '2026-11-01' };
  start({ row });
  expect(await screen.findByText(/^New price .*80\.00 \/ Monthly from 2026-11-01\.$/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Change price' }));
  expect(await screen.findByText(/A change is scheduled for 2026-11-01/)).toBeDefined();
});
it('shows no scheduled change and no cancel action for a membership without one', async () => {
  start();
  await screen.findByRole('heading', { name: plan.name });
  expect(screen.queryByRole('button', { name: 'Cancel change' })).toBeNull();
  expect(screen.queryByText(/^Changes to/)).toBeNull();
});
it('says when there is no other plan to change to', async () => {
  start({ plans: [plan] });
  const dialog = await openDialog();
  expect(dialog.getByText(/no other active plan/)).toBeDefined();
});

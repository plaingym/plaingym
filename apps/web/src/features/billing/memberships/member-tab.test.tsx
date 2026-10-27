// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { canStaff, type StaffRole } from '@plaingym/shared';
import type { Membership, Plan, ShellBootstrap } from '@plaingym/shared/contracts';
import { ShellServicesContext } from '../../../app/context.js';
import { createShellServices } from '../../../app/services.js';
import type { BillingClient } from '../catalog/api.js';
import { MembershipPanel } from './member-tab.js';

const id = (n: number) => '019a0af0-9c00-7000-8000-' + String(n).padStart(12, '0');
const createdAt = '2026-10-27T00:30:00Z';
const plan: Plan = { id: id(2), createdAt, name: 'Unlimited classes', currency: 'CAD', amountCents: 10000, interval: 'monthly', signupFeeCents: 0, trialDays: 0, commitmentMonths: null, active: true, revision: 1, taxRateIds: [] };
const membership: Membership = { id: id(3), createdAt, memberId: id(4), householdId: id(5), planId: plan.id, status: 'active', currency: 'CAD', amountCents: 10000, interval: 'monthly', startsOn: '2026-10-01', nextDueOn: '2026-11-01', trialEndsOn: null, frozenAt: null, resumesOn: null, cancelledAt: null, commitmentEndsOn: null, revision: 1 };
function start(role: StaffRole) {
  const data: ShellBootstrap = { gym: { id: id(1), name: 'Academy', timezone: 'America/Vancouver', currency: 'CAD', enabledModules: [] }, session: { userId: id(6), roles: [role], member: false }, login: { password: true, magicLink: false } };
  const client = { plans: vi.fn(async () => [plan]), memberships: vi.fn(async () => [membership]),
    member: vi.fn(async () => ({ householdId: membership.householdId })), householdBilling: vi.fn(async () => ({ billingDay: null })),
    settings: vi.fn(async () => { throw new Error('Settings are restricted'); }),
  } as unknown as BillingClient;
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
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
  await screen.findByText('2026-11-01');
  expect(client.plans).not.toHaveBeenCalled();
});

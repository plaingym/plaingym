// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createWebRegistries, type StaffRole } from '@plaingym/shared';
import type { Household, Member } from '@plaingym/shared/contracts';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { createRegistries, type ExtensionView } from '../../lib/registries.js';
import { invoiceClient, InvoiceRequestError } from '../billing/invoices/api.js';
import { MemberTabs } from '../members/profile.js';
import { MemberTabActivity } from '../members/tab-activity.js';
import { MemberLinksTab } from './member-links.js';
import { registration } from './registrations.js';

vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('../billing/invoices/api.js', async importOriginal => ({
  ...await importOriginal<typeof import('../billing/invoices/api.js')>(),
  invoiceClient: { member: vi.fn(), household: vi.fn(), householdMembers: vi.fn(), link: vi.fn() },
}));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a>, useNavigate: () => vi.fn() }));

const id = (n: number) => '019ab4f0-0000-7000-8000-' + String(n).padStart(12, '0');
const gymId = id(1), homeId = id(2), memberId = id(3), otherId = id(4), createdAt = '2026-10-22T12:00:00Z';
const consent = { at: '2026-10-01T00:00:00Z', source: 'staff' as const }, ready = { phoneValid: true, phoneE164: '+16045550100', notices: consent, announcements: null };
const member: Member = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: 'pay@example.com', phone: null, photoKey: null,
  sms: ready, dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt };
const other: Member = { ...member, id: otherId, firstName: 'Sam', email: 'sam@example.com' };
const household: Household = { id: homeId, name: 'Smith family', email: 'pay@example.com', phone: null,
  sms: { phoneValid: true, phoneE164: '+16045550199', notices: consent }, address: {}, revision: 1, createdAt };
const api = vi.mocked(invoiceClient);
const sent = { data: { purpose: 'onboarding' } } as never;

function bootstrap(roles: readonly StaffRole[]) {
  const data: ShellBootstrap = { gym: { id: gymId, name: 'Test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: id(9), displayName: 'Test User', roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], initialData: data, queryFn: async () => data }).getCurrentResult());
}
function view(component: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
async function open(choices: { purpose?: string; delivery?: string } = {}) {
  view(<MemberLinksTab memberId={memberId}/>);
  const purpose = await screen.findByLabelText('Purpose');
  if (choices.purpose) fireEvent.change(purpose, { target: { value: choices.purpose } });
  if (choices.delivery) fireEvent.change(screen.getByLabelText('Send by'), { target: { value: choices.delivery } });
}
const submit = () => fireEvent.submit(screen.getByLabelText('Purpose').closest('form')!);
const option = (name: RegExp) => screen.getByRole('option', { name }) as HTMLOptionElement;
function expectSevenDays(expiresAt: string) {
  expect(Math.abs(Date.parse(expiresAt) - Date.now() - 7 * 86400_000)).toBeLessThan(60_000);
}

beforeEach(() => {
  bootstrap(['front_desk']);
  api.member.mockResolvedValue(member);
  api.household.mockResolvedValue(household);
  api.householdMembers.mockResolvedValue([member, other]);
  api.link.mockResolvedValue(sent);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); sessionStorage.clear(); });

it('emails a signing link for this member, expiring in seven days', async () => {
  await open({ purpose: 'sign_waiver' });
  submit();
  expect(await screen.findByText('Link sent.')).toBeDefined();
  expect(api.link).toHaveBeenCalledTimes(1);
  const [request, generation, sms] = api.link.mock.calls[0]!;
  expect(request).toMatchObject({ purpose: 'sign_waiver', householdId: homeId, memberId });
  expectSevenDays(request.expiresAt);
  expect(generation).toMatch(/^[0-9a-f-]{36}$/);
  expect(sms).toBeUndefined();
});
it('texts a card update link to the billing phone', async () => {
  await open({ purpose: 'update_card', delivery: 'sms:household' });
  submit();
  await screen.findByText('Link sent.');
  const [request, , sms] = api.link.mock.calls[0]!;
  expect(request).toEqual({ purpose: 'update_card', householdId: homeId, expiresAt: expect.any(String) });
  expectSevenDays(request.expiresAt);
  expect(sms).toEqual({ channel: 'sms' });
});
it('texts a registration link to one household member', async () => {
  await open({ purpose: 'onboarding', delivery: 'sms:' + otherId });
  submit();
  await screen.findByText('Link sent.');
  expect(api.link.mock.calls[0]![0]).toEqual({ purpose: 'onboarding', householdId: homeId, expiresAt: expect.any(String) });
  expect(api.link.mock.calls[0]![2]).toEqual({ channel: 'sms', recipientMemberId: otherId });
});
it('limits a card update text to the payer, but not a registration or signing link', async () => {
  await open({ purpose: 'update_card' });
  expect(option(/^Text: Sam Smith/).textContent).toBe('Text: Sam Smith — only the payer');
  expect(option(/^Text: Sam Smith/).disabled).toBe(true);
  for (const purpose of ['onboarding', 'sign_waiver']) {
    fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: purpose } });
    expect(option(/^Text: Sam Smith/).textContent).toBe('Text: Sam Smith');
    expect(option(/^Text: Sam Smith/).disabled).toBe(false);
  }
});
it('falls back to email when a purpose change disables the chosen text recipient', async () => {
  await open({ purpose: 'onboarding', delivery: 'sms:' + otherId });
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'update_card' } });
  expect((screen.getByLabelText('Send by') as HTMLSelectElement).value).toBe('email');
  // Switching back never brings the text recipient back unasked.
  fireEvent.change(screen.getByLabelText('Purpose'), { target: { value: 'onboarding' } });
  expect((screen.getByLabelText('Send by') as HTMLSelectElement).value).toBe('email');
  submit();
  await screen.findByText('Link sent.');
  expect(api.link.mock.calls[0]![2]).toBeUndefined();
});
it('disables texts without notices consent and to an erased member', async () => {
  api.household.mockResolvedValue({ ...household, sms: { ...household.sms, notices: null } });
  api.householdMembers.mockResolvedValue([member, { ...other, anonymizedAt: createdAt }]);
  await open();
  expect(option(/^Text: billing phone/).textContent).toBe('Text: billing phone — no notices consent');
  expect(option(/^Text: billing phone/).disabled).toBe(true);
  expect(option(/^Text: Sam Smith/).textContent).toBe('Text: Sam Smith — member erased');
  expect(option(/^Text: Sam Smith/).disabled).toBe(true);
  expect(screen.getByText('Texts go only to numbers with notices consent. The gym is charged for each text.')).toBeDefined();
});
it('shows a link without sending one', async () => {
  api.link.mockResolvedValue({ data: { link: {}, token: 'a'.repeat(43) } } as never);
  await open({ delivery: 'copy' });
  submit();
  const input = await screen.findByLabelText('Link');
  expect((input as HTMLInputElement).value).toBe(location.origin + '/l/' + 'a'.repeat(43));
  expect(api.link).toHaveBeenCalledTimes(1);
  expect(api.link.mock.calls[0]).toHaveLength(1);
  expect(screen.queryByText('Link sent.')).toBeNull();
});
it('reuses the generation after a network error and takes a new one for a deliberate resend', async () => {
  api.link.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ data: { purpose: 'onboarding', outcome: 'unknown' } } as never);
  await open();
  submit();
  expect(await screen.findByText("The link couldn't be sent. Try again.")).toBeDefined();
  submit();
  expect(await screen.findByText("We couldn't confirm the send. Check before sending again.")).toBeDefined();
  expect(screen.getByRole('button', { name: 'Send again' })).toBeDefined();
  expect(api.link.mock.calls[1]![1]).toBe(api.link.mock.calls[0]![1]);
  submit();
  await screen.findByText('Link sent.');
  expect(api.link.mock.calls[2]![1]).toMatch(/^[0-9a-f-]{36}$/);
  expect(api.link.mock.calls[2]![1]).not.toBe(api.link.mock.calls[1]![1]);
});
it.each([
  ['sms:household', new InvoiceRequestError('sms_payer_only'), 'Card update links can only be texted to the payer'],
  ['email', new InvoiceRequestError('payments_unavailable'), "The link wasn't emailed. Member email may be turned off"],
  ['email', new InvoiceRequestError('save_failed'), "The link couldn't be sent. Try again."],
])('shows a %s refusal in a focused alert', async (delivery, failure, message) => {
  api.link.mockRejectedValue(failure);
  await open({ delivery });
  submit();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(message);
  await waitFor(() => expect(document.activeElement).toBe(alert));
});
// The server answers a send to a household without an email with a 503 and no reason.
it('explains a missing household email', async () => {
  api.household.mockResolvedValue({ ...household, email: null });
  api.link.mockRejectedValue(new InvoiceRequestError('payments_unavailable'));
  await open();
  submit();
  expect((await screen.findByRole('alert')).textContent).toContain('The household has no valid email address.');
});
it('loads only while the tab is open, and afresh each time it opens', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const tab = (active: boolean) => <QueryClientProvider client={client}><MemberTabActivity value={active}><MemberLinksTab memberId={memberId}/></MemberTabActivity></QueryClientProvider>;
  const { rerender } = render(tab(false));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.member).not.toHaveBeenCalled();
  rerender(tab(true));
  await screen.findByLabelText('Purpose');
  rerender(tab(false));
  api.household.mockResolvedValue({ ...household, sms: { ...household.sms, notices: null } });
  rerender(tab(true));
  await waitFor(() => expect(option(/^Text: billing phone/).disabled).toBe(true));
  expect(api.household).toHaveBeenCalledTimes(2);
});
it('shows no form for an erased member', async () => {
  api.member.mockResolvedValue({ ...member, anonymizedAt: createdAt });
  view(<MemberLinksTab memberId={memberId}/>);
  expect(await screen.findByText("This member's details were erased, so no link can be sent.")).toBeDefined();
  expect(screen.queryByLabelText('Purpose')).toBeNull();
  expect(api.household).not.toHaveBeenCalled();
});
it('offers a retry when the household fails to load', async () => {
  api.household.mockRejectedValueOnce(new Error('offline'));
  view(<MemberLinksTab memberId={memberId}/>);
  fireEvent.click(await screen.findByRole('button', { name: /retry|try again/i }));
  expect(await screen.findByLabelText('Purpose')).toBeDefined();
});
it('registers the Links tab for staff who can send links', () => {
  const entry = createRegistries().memberTabs.forModules(new Set()).find(row => row.id === 'memberTabs.links');
  expect(entry).toMatchObject({ labelKey: 'links/member-links:tab', enabled: true, permission: { kind: 'staff', capability: 'links.send' }, component: MemberLinksTab });
});
it.each([['coach', false], ['front_desk', true]] as const)('shows the Links tab on the member page to %s: %s', async (role, shown) => {
  bootstrap([role]);
  view(<MemberTabs memberId={memberId} roles={[role]} enabledModules={new Set()} registries={createWebRegistries<ExtensionView>([registration])}/>);
  expect(screen.queryByRole('tab', { name: 'Links' }) !== null).toBe(shown);
  if (shown) expect(await screen.findByLabelText('Purpose')).toBeDefined();
});

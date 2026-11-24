// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Member } from '@plaingym/shared/contracts';
import { MemberForm } from './member-form.js';
import { memberRequest } from './api.js';
import { useBootstrap } from '../../app/context.js';

vi.mock('./api.js', () => ({ memberRequest: vi.fn() }));
vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
/** The gym's country code as the shell bootstrap carries it (none: the gym has not set one). */
function gymCountry(country?: string) {
  vi.mocked(useBootstrap).mockReturnValue({ data: { gym: { ...(country ? { country } : {}) } } } as unknown as ReturnType<typeof useBootstrap>);
}
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002';
const member: Member = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null,
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
const hint = "Needed for the household's payer to sign waivers and give text consent for a member under 18.";
function view(component: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
const describedBy = (input: HTMLElement) => (input.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ');
beforeEach(() => { vi.mocked(memberRequest).mockResolvedValue({ data: member }); gymCountry('CA'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('describes a new member\'s date of birth with what it is needed for', () => {
  view(<MemberForm householdId={homeId}/>);
  expect(describedBy(screen.getByLabelText('Date of birth'))).toBe(hint);
});
it('describes an existing member\'s date of birth with what it is needed for', () => {
  view(<MemberForm member={{ ...member, dateOfBirth: '2010-05-05' }} householdId={homeId}/>);
  expect(describedBy(screen.getByLabelText('Date of birth'))).toBe(hint);
});
const noGymCountry = "Set the gym's country code in Settings → Gym details to preselect it here.";
it('creates a member with the gym\'s country code joined to the typed phone', async () => {
  view(<MemberForm householdId={homeId}/>);
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'New' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Person' } });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '604 555 0123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create member' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members', 'POST', expect.objectContaining({ phone: '+1 604 555 0123' })));
  expect(screen.queryByText(noGymCountry)).toBeNull();
});
it('sends no phone when only another field of a member with a stored phone changes', async () => {
  view(<MemberForm member={{ ...member, phone: '(604) 555-0123' }} householdId={homeId}/>);
  expect((screen.getByLabelText('Phone') as HTMLInputElement).value).toBe('(604) 555-0123');
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Alexandra' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalled());
  const body = vi.mocked(memberRequest).mock.calls[0]![3] as Record<string, unknown>;
  expect(body).toMatchObject({ firstName: 'Alexandra' });
  expect(body).not.toHaveProperty('phone');
});
it('says where to set the gym\'s country code when the gym has none', () => {
  gymCountry();
  view(<MemberForm householdId={homeId}/>);
  expect(screen.getByText(noGymCountry)).toBeDefined();
  expect((screen.getByRole('combobox', { name: 'Country code' }) as HTMLSelectElement).value).toBe('');
});
it('drops a country chosen with an empty phone after creating a member', async () => {
  view(<MemberForm householdId={homeId}/>);
  const country = screen.getByRole('combobox', { name: 'Country code' }) as HTMLSelectElement;
  fireEvent.change(country, { target: { value: 'GB' } });
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'First' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Person' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create member' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalledTimes(1));
  expect(country.value).toBe('CA');
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Second' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Person' } });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '604 555 0123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create member' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalledTimes(2));
  expect(vi.mocked(memberRequest).mock.calls[1]![3]).toMatchObject({ phone: '+1 604 555 0123' });
});
it('still saves a changed date of birth', async () => {
  view(<MemberForm member={member} householdId={homeId}/>);
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2010-05-05' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members/' + memberId, 'PATCH', expect.objectContaining({ dateOfBirth: '2010-05-05' })));
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Member } from '@plaingym/shared/contracts';
import { MemberForm } from './member-form.js';
import { memberRequest } from './api.js';

vi.mock('./api.js', () => ({ memberRequest: vi.fn() }));
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002';
const member: Member = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null,
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
const hint = "Needed for the household's payer to sign waivers and give text consent for a member under 18.";
function view(component: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
const describedBy = (input: HTMLElement) => (input.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' ');
beforeEach(() => { vi.mocked(memberRequest).mockResolvedValue({ data: member }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('describes a new member\'s date of birth with what it is needed for', () => {
  view(<MemberForm householdId={homeId}/>);
  expect(describedBy(screen.getByLabelText('Date of birth'))).toBe(hint);
});
it('describes an existing member\'s date of birth with what it is needed for', () => {
  view(<MemberForm member={{ ...member, dateOfBirth: '2010-05-05' }} householdId={homeId}/>);
  expect(describedBy(screen.getByLabelText('Date of birth'))).toBe(hint);
});
it('still saves a changed date of birth', async () => {
  view(<MemberForm member={member} householdId={homeId}/>);
  fireEvent.change(screen.getByLabelText('Date of birth'), { target: { value: '2010-05-05' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members/' + memberId, 'PATCH', expect.objectContaining({ dateOfBirth: '2010-05-05' })));
});

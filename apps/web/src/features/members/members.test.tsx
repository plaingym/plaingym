// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { createWebRegistries } from '@plaingym/shared';
import type { ExtensionView } from '../../lib/registries.js';
import { MemberProfile, MemberTabs } from './profile.js';
import { MemberForm } from './member-form.js';
import { HouseholdForm } from './households.js';
import { memberRequest } from './api.js';
import type { Member } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';

vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('./api.js', () => ({ memberRequest: vi.fn(), resizeMemberPhoto: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002';
const member: Member = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null,
  dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
function bootstrap(roles: readonly StaffRole[]) {
  const data: ShellBootstrap = { gym: { id: homeId, name: 'Test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: memberId, roles, member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], initialData: data, queryFn: async () => data }).getCurrentResult());
}
function view(component: ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider>);
}
beforeEach(() => {
  bootstrap(['front_desk']);
  vi.mocked(memberRequest).mockImplementation(async (_schema, path) => {
    if (path.endsWith('/medical-notes')) return { data: { id: memberId, medicalNotes: 'Private medical note', revision: 1 } };
    if (path.endsWith('/billing-settings')) return { data: { id: homeId, billingDay: 1, familyDiscountBasisPoints: 0, revision: 1 } };
    if (path.includes('/households/')) return { data: { id: homeId, name: 'Smith family', email: null, phone: null, address: {}, revision: 1, createdAt: member.createdAt } };
    if (path.endsWith('/tags') || path.startsWith('/api/member-tags')) return { data: [], pagination: { limit: 100, offset: 0, total: 0 } };
    return { data: member };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('member admin UI', () => {
  it('renders and switches all registered member tabs and supplies the member ID', () => {
    const registries = createWebRegistries<ExtensionView>([{ memberTabs: [
      { id: 'test.one', labelKey: 'members/members:profile', enabled: true, permission: { kind: 'staff', capability: 'members.read' }, component: ({ memberId }) => <p>One {memberId}</p> },
      { id: 'test.two', labelKey: 'members/members:tags', enabled: true, permission: { kind: 'staff', capability: 'members.read' }, component: ({ memberId }) => <p>Two {memberId}</p> },
      { id: 'test.secret', labelKey: 'members/members:medicalNotes', enabled: true, permission: { kind: 'staff', capability: 'medical.read' }, component: () => <p>Secret tab</p> },
      { id: 'test.module', moduleId: 'website', labelKey: 'members/members:photo', enabled: true, permission: { kind: 'staff', capability: 'members.read' }, component: () => <p>Disabled module</p> },
    ] }]);
    view(<MemberTabs memberId={memberId} roles={['front_desk']} enabledModules={new Set()} registries={registries}/>);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tabpanel').textContent).toContain('One ' + memberId);
    fireEvent.click(screen.getByRole('tab', { name: 'Tags' }));
    expect(screen.getByRole('tabpanel').textContent).toContain('Two ' + memberId);
    expect(screen.queryByText('Secret tab')).toBeNull(); expect(screen.queryByText('Disabled module')).toBeNull();
  });
  it('front desk never requests or renders medical notes', async () => {
    view(<MemberProfile memberId={memberId}/>);
    await screen.findByRole('heading', { name: 'Alex Smith' });
    expect(screen.queryByText('Medical notes')).toBeNull();
    expect(vi.mocked(memberRequest).mock.calls.some((call) => call[1].endsWith('/medical-notes'))).toBe(false);
  });
  it('coaches can read medical notes but cannot edit them or billing', async () => {
    bootstrap(['coach']); view(<MemberProfile memberId={memberId}/>);
    await screen.findByText('Private medical note');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(vi.mocked(memberRequest).mock.calls.some((call) => call[1].includes('billing-settings'))).toBe(false);
  });
  it('submits member changes with the revision and validates emergency contacts', async () => {
    view(<MemberForm member={member} householdId={homeId}/>);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add emergency contact' }));
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Guardian' } });
    fireEvent.change(screen.getByLabelText('Contact phone'), { target: { value: '555-0123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members/' + memberId, 'PATCH', expect.objectContaining({ revision: 1, firstName: 'Changed', emergencyContacts: [{ name: 'Guardian', phone: '555-0123', relationship: null, email: null }] })));
  });
  it('never carries a member draft to another cached member with the same revision', async () => {
    bootstrap(['owner']);
    const other = { ...member, id: '019ab4f0-0000-7000-8000-000000000003', firstName: 'Blair', lastName: 'Jones' };
    const fallback = vi.mocked(memberRequest).getMockImplementation()!;
    vi.mocked(memberRequest).mockImplementation(async (schema, path, ...rest) => path === '/api/members/' + other.id ? { data: other } : fallback(schema, path, ...rest));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(<QueryClientProvider client={client}><MemberProfile memberId={memberId}/></QueryClientProvider>);
    fireEvent.change(await screen.findByLabelText('First name'), { target: { value: 'Draft' } });
    rerender(<QueryClientProvider client={client}><MemberProfile memberId={other.id}/></QueryClientProvider>);
    await screen.findByRole('heading', { name: 'Blair Jones' });
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Blair');
  });
  it('keeps unsaved edits when another save advances the revision, and refuses to overwrite a changed field', async () => {
    const { rerender } = view(<MemberForm member={member} householdId={homeId}/>);
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Draft' } });
    // A photo or medical-note save advances the shared revision without touching the profile fields.
    rerender(<QueryClientProvider client={new QueryClient()}><MemberForm member={{ ...member, revision: 2, photoKey: 'photo' }} householdId={homeId}/></QueryClientProvider>);
    expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members/' + memberId, 'PATCH', { revision: 2, firstName: 'Draft' }));
    vi.mocked(memberRequest).mockClear();
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Second draft' } });
    rerender(<QueryClientProvider client={new QueryClient()}><MemberForm member={{ ...member, revision: 3, firstName: 'Changed elsewhere' }} householdId={homeId}/></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('alert');
    expect(memberRequest).not.toHaveBeenCalled();
  });
  it('creates a household with empty optional address fields omitted', async () => {
    view(<HouseholdForm/>);
    fireEvent.change(screen.getByLabelText('Household name'), { target: { value: 'New family' } });
    fireEvent.change(screen.getByLabelText('Country code (two letters)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create household' }));
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/households', 'POST', expect.objectContaining({ name: 'New family', address: {} })));
  });
});

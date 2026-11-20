// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ShellBootstrap } from '../../app/services.js';
import { useBootstrap } from '../../app/context.js';
import { createWebRegistries } from '@plaingym/shared';
import type { ExtensionView } from '../../lib/registries.js';
import { MemberProfile, MemberTabs } from './profile.js';
import { MemberForm } from './member-form.js';
import { MembersPage } from './page.js';
import { HouseholdDetails, HouseholdForm } from './households.js';
import { memberRequest } from './api.js';
import { ApiError } from '../../lib/api.js';
import { memberDeleteBlockedReason } from '@plaingym/shared/contracts';
import type { Member } from '@plaingym/shared/contracts';
import type { StaffRole } from '@plaingym/shared';

vi.mock('../../app/context.js', () => ({ useBootstrap: vi.fn() }));
vi.mock('./api.js', () => ({ memberRequest: vi.fn(), resizeMemberPhoto: vi.fn() }));
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn(async () => undefined) }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a>, useNavigate: () => navigate }));
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002';
const member: Member = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null,
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  dateOfBirth: null, status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
function bootstrap(roles: readonly StaffRole[]) {
  const data: ShellBootstrap = { gym: { id: homeId, name: 'Test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: memberId, displayName: 'Test User', roles, member: false }, login: { password: true, magicLink: false } };
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
    // The Portal access tab, shown to managers, lists the household's logins and invitations.
    if (path.includes('/portal-logins') || path.endsWith('/portal-invitations')) return { data: [], pagination: { limit: 20, offset: 0, total: 0 } };
    if (path.includes('/households/')) return { data: { id: homeId, name: 'Smith family', email: null, phone: null, sms: { phoneValid: false, phoneE164: null, notices: null }, address: {}, revision: 1, createdAt: member.createdAt } };
    if (path.endsWith('/tags') || path.startsWith('/api/member-tags')) return { data: [], pagination: { limit: 100, offset: 0, total: 0 } };
    return { data: member };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('member admin UI', () => {
  it('shows an invalid family percentage beside the field before transport', async () => {
    view(<HouseholdDetails householdId={homeId} gymId={homeId}/>);
    const field = await screen.findByLabelText('Family discount (%)');
    fireEvent.change(field, { target: { value: '1e1' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save billing settings' }).closest('form')!);
    expect(screen.getByRole('alert').textContent).toContain('Enter a percentage from 0 to 100');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(vi.mocked(memberRequest).mock.calls.some(call => call[2] === 'PATCH')).toBe(false);
  });
  it.each([['12.34', 1234], ['0', 0], ['00', 0], ['.5', 50], [' 10 ', 1000], ['100', 10000]])('saves a household discount of %s percent as %s basis points', async (percent, points) => {
    view(<HouseholdDetails householdId={homeId} gymId={homeId}/>);
    fireEvent.change(await screen.findByLabelText('Family discount (%)'), { target: { value: percent } });
    fireEvent.click(screen.getByRole('button', { name: 'Save billing settings' }));
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), `/api/households/${homeId}/billing-settings`, 'PATCH', expect.objectContaining({ familyDiscountBasisPoints: points })));
  });
  it('places tabs above profile fields and destructive actions in the last section at 360 px', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    bootstrap(['owner']); view(<MemberProfile memberId={memberId}/>);
    const firstName = await screen.findByLabelText('First name');
    const tabs = screen.getByRole('tablist');
    expect(tabs.compareDocumentPosition(firstName) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Profile', selected: true })).toBeDefined();
    const danger = screen.getByRole('region', { name: 'Erase or delete member data' });
    expect(within(danger).getByRole('button', { name: 'Erase personal data' })).toBeDefined();
    expect(within(danger).getByRole('button', { name: 'Delete member' })).toBeDefined();
    expect(danger.parentElement?.lastElementChild).toBe(danger);
  });
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
  it('opens the tab a link names in the URL hash, and ignores an unknown or malformed one', () => {
    const registries = createWebRegistries<ExtensionView>([{ memberTabs: ['one', 'two'].map((name) => ({ id: 'memberTabs.' + name, labelKey: 'members/members:' + (name === 'one' ? 'profile' : 'tags'), enabled: true,
      permission: { kind: 'staff' as const, capability: 'members.read' as const }, component: () => <p>Tab {name}</p> })) }]);
    const open = (hash: string) => { window.location.hash = hash; cleanup(); view(<MemberTabs memberId={memberId} roles={['front_desk']} enabledModules={new Set()} registries={registries}/>); };
    try {
      open('#memberTabs.two'); expect(screen.getByRole('tab', { name: 'Tags', selected: true })).toBeDefined();
      window.history.replaceState(null, '', '#memberTabs.one');
      fireEvent(window, new HashChangeEvent('hashchange'));
      expect(screen.getByRole('tab', { name: 'Profile', selected: true })).toBeDefined();
      window.history.replaceState(null, '', '#memberTabs.two');
      fireEvent(window, new HashChangeEvent('hashchange'));
      expect(screen.getByRole('tab', { name: 'Tags', selected: true })).toBeDefined();
      // An in-page anchor that names no tab, such as the skip link, keeps the open tab.
      window.history.replaceState(null, '', '#main-content');
      fireEvent(window, new HashChangeEvent('hashchange'));
      expect(screen.getByRole('tab', { name: 'Tags', selected: true })).toBeDefined();
      open('#memberTabs.missing'); expect(screen.getByRole('tab', { name: 'Profile', selected: true })).toBeDefined();
      open('#%'); expect(screen.getByRole('tab', { name: 'Profile', selected: true })).toBeDefined();
    } finally { window.location.hash = ''; }
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
    const help = screen.getByText(/Membership changes reset this status/);
    expect(screen.getByLabelText('Status').getAttribute('aria-describedby')).toBe(help.id);
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

  it('lets managers delete a member only after typing their name, then returns to the member list', async () => {
    bootstrap(['admin']); view(<MemberProfile memberId={memberId}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete member' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this member?' });
    const submit = within(dialog).getByRole('button', { name: 'Delete member' }) as HTMLButtonElement;
    const name = within(dialog).getByLabelText('Type the member’s name, Alex Smith, to confirm.');
    expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Alex Smit' } }); expect(submit.disabled).toBe(true);
    fireEvent.change(name, { target: { value: '  alex   SMITH ' } }); expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(memberRequest).toHaveBeenCalledWith(expect.anything(), '/api/members/' + memberId, 'DELETE', { revision: 1 }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/admin/members' }));
  });
  it('guards Cancel after a manager types a member deletion confirmation', async () => {
    bootstrap(['admin']); view(<MemberProfile memberId={memberId}/>);
    const open = await screen.findByRole('button', { name: 'Delete member' });
    const title = 'Delete this member?';
    fireEvent.click(open);
    let dialog = within(screen.getByRole('dialog', { name: title }));
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: title })).toBeNull();

    fireEvent.click(open);
    dialog = within(screen.getByRole('dialog', { name: title }));
    const name = dialog.getByRole<HTMLInputElement>('textbox');
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    expect(cancel.getAttribute('type')).toBe('button');
    fireEvent.change(name, { target: { value: 'Alex Smit' } });
    fireEvent.click(cancel);
    const prompt = dialog.getByText('Discard your unsaved changes?');
    fireEvent.click(dialog.getByRole('button', { name: 'Keep editing' }));
    expect(prompt.isConnected).toBe(false);
    expect(name.value).toBe('Alex Smit');
    expect(dialog.getByRole<HTMLButtonElement>('button', { name: 'Delete member' }).disabled).toBe(true);

    fireEvent.click(cancel);
    fireEvent.click(dialog.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('dialog', { name: title })).toBeNull();
    expect(vi.mocked(memberRequest).mock.calls.some(call => call[2] === 'DELETE')).toBe(false);

    fireEvent.click(open);
    dialog = within(screen.getByRole('dialog', { name: title }));
    expect(dialog.getByRole<HTMLInputElement>('textbox').value).toBe('');
  });
  it('keeps the delete confirmation open while pending and explains a refusal for billing records', async () => {
    bootstrap(['owner']);
    const loaded = vi.mocked(memberRequest).getMockImplementation()!;
    const response = Promise.withResolvers<void>();
    vi.mocked(memberRequest).mockImplementation(async (schema, path, method, ...rest) => {
      if (method === 'DELETE') {
        await response.promise;
        throw new ApiError(409, 'conflict', [memberDeleteBlockedReason]);
      }
      return loaded(schema, path, method, ...rest);
    });
    view(<MemberProfile memberId={memberId}/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete member' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this member?' });
    const controls = within(dialog);
    const name = controls.getByRole<HTMLInputElement>('textbox');
    const submit = controls.getByRole<HTMLButtonElement>('button', { name: 'Delete member' });
    const cancel = controls.getByRole<HTMLButtonElement>('button', { name: 'Cancel' });
    const close = controls.getByRole<HTMLButtonElement>('button', { name: 'Close dialog' });
    fireEvent.change(name, { target: { value: 'Alex Smith' } });
    fireEvent.click(submit);

    fireEvent(dialog, new Event('cancel', { cancelable: true })); // Escape triggers the native dialog cancel event.
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ left: 100, right: 500, top: 100, bottom: 500 } as DOMRect);
    // Use MouseEvent so jsdom supplies coordinates for the pointerdown.
    fireEvent(dialog, new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    fireEvent.click(dialog, { clientX: 10, clientY: 10 });
    fireEvent.click(close);
    expect(screen.getByRole('dialog', { name: 'Delete this member?' })).toBe(dialog);
    expect(controls.queryByText('Discard your unsaved changes?')).toBeNull();
    expect(close.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(submit.disabled).toBe(true);
    expect(name.value).toBe('Alex Smith');
    expect(vi.mocked(memberRequest).mock.calls.filter(call => call[2] === 'DELETE')).toHaveLength(1);

    response.resolve();
    expect((await controls.findByRole('alert')).textContent).toContain('This member has billing records');
    expect(screen.getByRole('dialog', { name: 'Delete this member?' })).toBe(dialog);
    expect(name.value).toBe('Alex Smith');
    expect(submit.disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(controls.getByText('Discard your unsaved changes?')).toBeDefined();
  });
  it('offers no delete to front desk or coaches', async () => {
    for (const role of ['front_desk', 'coach'] as const) {
      bootstrap([role]); view(<MemberProfile memberId={memberId}/>);
      await screen.findByText('Alex Smith');
      expect(screen.queryByRole('button', { name: 'Delete member' })).toBeNull();
      cleanup();
    }
  });
  it('groups the member list range and total', async () => {
    const fallback = vi.mocked(memberRequest).getMockImplementation()!;
    vi.mocked(memberRequest).mockImplementation(async (schema, path, ...rest) => path.startsWith('/api/members?')
      ? { data: [member], pagination: { limit: 50, offset: 0, total: 2400 } } : fallback(schema, path, ...rest));
    view(<MembersPage/>);
    expect(await screen.findByText('1–1 of 2,400 members')).toBeDefined();
  });
});

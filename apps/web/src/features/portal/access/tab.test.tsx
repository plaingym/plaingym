// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ShellBootstrap } from '../../../app/services.js';
import { useBootstrap } from '../../../app/context.js';
import { PortalAccessTab } from './tab.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: vi.fn() }));
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002', inviteId = '019ab4f0-0000-7000-8000-000000000003';
const person = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null, dateOfBirth: '1990-01-01',
  sms: { phoneValid: false, phoneE164: null, notices: null, announcements: null },
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
const invitation = { id: inviteId, scope: 'member', memberId, memberName: 'Alex Smith', email: 'alex@example.test', expiresAt: '2026-11-04T12:00:00.000Z' };
const login = { id: inviteId, householdId: homeId, userId: memberId, scope: 'member', memberId, email: 'old-login@example.test', createdAt: person.createdAt };
const currentEmail = 'current@example.test';
const genericError = "We couldn't update portal access. Check the details and try again.";
const refusalHint = "The join couldn't set up a portal login for this address because it belongs to a staff login. Invite the member with another address.";
let outstanding: unknown[] = [], fail = false, listFails = false, uncertain = false;
let memberEmail: string | null, logins: unknown[], refused: boolean, inviteError: { status: number; reason?: string[] } | undefined;
const generations: string[] = [];
const calls: [string, string][] = [];
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push([method, path]);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === `/api/households/${homeId}/portal-invitations` && method === 'POST') {
      if (inviteError) return json({ error: { code: 'request_failed', ...(inviteError.reason ? { details: { reason: inviteError.reason } } : {}) } }, inviteError.status);
      generations.push((JSON.parse(String(init?.body)) as { sendGeneration: string }).sendGeneration);
      return json({ data: { delivery: 'email', invitation: { userId: memberId, scope: 'member', memberId, expiresAt: invitation.expiresAt }, ...(uncertain ? { outcome: 'unknown' } : {}) } });
    }
    if (path === '/api/members/' + memberId) return json({ data: { ...person, email: memberEmail } });
    if (path.includes('/portal-logins')) return json({ data: logins, pagination: { limit: 20, offset: 0, total: logins.length },
      ...(refused ? { inviteRefused: { reason: 'staff_identity' } } : {}) });
    if (path === `/api/households/${homeId}/portal-invitations` && method === 'GET') return listFails ? json({ error: { code: 'internal' } }, 500) : json({ data: outstanding });
    if (path === `/api/households/${homeId}/portal-invitations/${inviteId}` && method === 'DELETE') {
      if (fail) return json({ error: { code: 'not_found' } }, 404);
      outstanding = []; return json({ data: null });
    }
    return json({ error: { code: 'not_found' } }, 404);
  }));
}
function start() {
  const data: ShellBootstrap = { gym: { id: homeId, name: 'Test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: memberId, displayName: 'Test User', roles: ['front_desk'], member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], initialData: data, queryFn: async () => data }).getCurrentResult());
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={cache}><PortalAccessTab memberId={memberId}/></QueryClientProvider>), cache };
}
beforeEach(() => {
  sessionStorage.clear(); uncertain = false; generations.length = 0; outstanding = [invitation]; fail = false; listFails = false; calls.length = 0;
  memberEmail = null; logins = []; refused = false; inviteError = undefined; stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('portal access tab invitations', () => {
  it('lists outstanding invitations with scope, member, address and expiry, and hides the list when there are none', async () => {
    const view = start();
    await screen.findByRole('heading', { name: 'Invitations not yet accepted' });
    expect(screen.getByText('alex@example.test')).toBeDefined();
    expect(screen.getByText(/This member only/).textContent).toContain('Alex Smith');
    expect(screen.getByText('Expires').parentElement?.querySelector('time')?.getAttribute('datetime')).toBe(invitation.expiresAt);
    view.unmount(); outstanding = []; start();
    await screen.findByText('No portal logins yet');
    expect(screen.queryByRole('heading', { name: 'Invitations not yet accepted' })).toBeNull();
  });
  it('still shows the logins and the invite button when the invitation list fails, and retries it', async () => {
    listFails = true; const user = userEvent.setup(); start();
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't load the outstanding invitations");
    expect(screen.getByRole('button', { name: 'Invite' })).toBeDefined();
    listFails = false; await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('alex@example.test');
  });
  it('revokes an invitation after confirmation and refreshes the list', async () => {
    const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Revoke invitation' }));
    expect(screen.getByText('Revoke this invitation? Its link will stop working.')).toBeDefined();
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('dialog').querySelector('button[type=submit]')!);
    await waitFor(() => expect(calls).toContainEqual(['DELETE', `/api/households/${homeId}/portal-invitations/${inviteId}`]));
    await waitFor(() => expect(screen.queryByText('alex@example.test')).toBeNull());
    expect(screen.queryByRole('heading', { name: 'Invitations not yet accepted' })).toBeNull();
  });
  it('keeps the invitation and the dialog, with an error, when revoking fails', async () => {
    fail = true; const user = userEvent.setup(); start();
    await user.click(await screen.findByRole('button', { name: 'Revoke invitation' }));
    await user.click(screen.getByRole('dialog').querySelector('button[type=submit]')!);
    expect((await screen.findByRole('alert')).textContent).toContain("couldn't update portal access");
    expect(screen.getByText('alex@example.test')).toBeDefined();
  });
});

describe('portal access tab invitation guidance', () => {
  it.each([
    [409, ['unrelated', 'already_linked_household'], 'This login already has access to this household. Revoke its current access first to change its role.'],
    [409, ['member_has_login'], 'This member already has a portal login.'],
    [403, ['staff_account'], 'This address belongs to a staff login. Use another address.'],
    [400, ['adult_birth_date_required'], 'Member-only access needs a date of birth showing they are at least 18.'],
    [500, undefined, genericError],
    [409, undefined, genericError],
    [409, ['unknown'], genericError],
  ] as const)('explains invite refusal %s %j', async (status, reason, message) => {
    inviteError = { status, ...(reason === undefined ? {} : { reason: [...reason] }) };
    memberEmail = currentEmail;
    const user = userEvent.setup();
    start();
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Invite' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });
  it.each([['member save', ['members']], ['profile refresh', ['members', homeId]]])('prefills the new address after %s', async (_action, queryKey) => {
    memberEmail = 'before@example.test';
    const user = userEvent.setup(), { cache } = start();
    await screen.findByRole('button', { name: 'Invite' });
    memberEmail = currentEmail;
    await act(async () => { await cache.invalidateQueries({ queryKey }); });
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect((screen.getByLabelText('Login email') as HTMLInputElement).value).toBe(currentEmail);
  });
  it('opens an empty email field for a member without an address, with no refusal hint or old-address note', async () => {
    const user = userEvent.setup();
    start();
    await screen.findByText(invitation.email);
    expect(screen.queryByText(refusalHint)).toBeNull();
    expect(screen.queryByText(/current email/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Invite' }));
    expect((screen.getByLabelText('Login email') as HTMLInputElement).value).toBe('');
  });
  it('shows the join refusal hint and opens Invite from it with an empty email field', async () => {
    refused = true;
    memberEmail = currentEmail;
    const user = userEvent.setup();
    start();
    const hint = await screen.findByText(refusalHint);
    await user.click(within(hint.parentElement!).getByRole('button', { name: 'Invite' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Invite' }));
    expect((dialog.getByLabelText('Login email') as HTMLInputElement).value).toBe('');
  });
  it('marks old addresses only for access specific to this member', async () => {
    memberEmail = currentEmail;
    const caseMatch = { ...invitation, id: homeId, email: currentEmail.toUpperCase() };
    const payer = { ...invitation, id: memberId, scope: 'payer', memberId: null, email: 'payer@example.test' };
    const otherMember = { ...invitation, id: '019ab4f0-0000-7000-8000-000000000004', memberId: homeId, email: 'another@example.test' };
    outstanding = [invitation, caseMatch, payer, otherMember];
    logins = [login];
    start();
    const row = (email: string) => within(screen.getByText(email).closest('li')!);
    const note = "Not the member's current email (" + currentEmail + ').';
    await screen.findByText(invitation.email);
    expect(row(invitation.email).getByText(note)).toBeDefined();
    expect(row(login.email).getByText(note)).toBeDefined();
    for (const entry of [caseMatch, payer, otherMember]) expect(row(entry.email).queryByText(note)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Resend to current email' })).toHaveLength(1);
  });
  it.each([false, true])('confirms before revoking the old invitation and opens Invite only on success (failure %s)', async (fails) => {
    fail = fails;
    memberEmail = currentEmail;
    const user = userEvent.setup();
    start();
    await user.click(await screen.findByRole('button', { name: 'Resend to current email' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke invitation' });
    expect(calls.some(([method]) => method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Revoke invitation' }));
    if (fails) {
      expect((await screen.findByRole('alert')).textContent).toBe(genericError);
      expect(screen.getByText(invitation.email)).toBeDefined();
      expect(screen.queryByRole('dialog', { name: 'Invite' })).toBeNull();
    } else {
      const next = within(await screen.findByRole('dialog', { name: 'Invite' }));
      expect((next.getByLabelText('Login email') as HTMLInputElement).value).toBe(currentEmail);
      expect((next.getByLabelText('Access') as HTMLSelectElement).value).toBe('member');
      expect(screen.queryByText(invitation.email)).toBeNull();
      expect(calls.filter(([method]) => method === 'POST')).toEqual([]);
    }
    expect(calls).toContainEqual(['DELETE', `/api/households/${homeId}/portal-invitations/${inviteId}`]);
  });
});

it('keeps an uncertain invitation in the dialog with a deliberate resend', async () => {
  uncertain = true; const user = userEvent.setup(); start();
  await user.click(await screen.findByRole('button', { name: 'Invite' }));
  await user.type(screen.getByLabelText('Login email'), 'alex@example.test');
  await user.selectOptions(screen.getByLabelText('Invitation delivery'), 'email');
  await user.click(screen.getByRole('dialog').querySelector('button[type=submit]')!);
  expect((await screen.findByRole('status')).textContent).toContain('may have been delivered');
  expect(generations).toHaveLength(1);
  uncertain = false; await user.click(screen.getByRole('button', { name: 'Send again' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(generations).toHaveLength(2); expect(generations[1]).not.toBe(generations[0]);
});

it('drops a stale uncertain warning when the dialog reopens, and replays the same generation', async () => {
  uncertain = true; const user = userEvent.setup(); start();
  const send = async () => {
    await user.click(await screen.findByRole('button', { name: 'Invite' }));
    await user.type(screen.getByLabelText('Login email'), 'alex@example.test');
    await user.selectOptions(screen.getByLabelText('Invitation delivery'), 'email');
  };
  await send(); await user.click(screen.getByRole('dialog').querySelector('button[type=submit]')!);
  await screen.findByRole('status');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await send();
  expect(screen.queryByText(/may have been delivered/)).toBeNull(); expect(screen.queryByRole('button', { name: 'Send again' })).toBeNull();
  await user.click(screen.getByRole('dialog').querySelector('button[type=submit]')!);
  await screen.findByRole('status');
  expect(generations).toHaveLength(2); expect(generations[1]).toBe(generations[0]);
});

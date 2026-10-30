// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import type { ShellBootstrap } from '../../../app/services.js';
import { useBootstrap } from '../../../app/context.js';
import { PortalAccessTab } from './tab.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: vi.fn() }));
const homeId = '019ab4f0-0000-7000-8000-000000000001', memberId = '019ab4f0-0000-7000-8000-000000000002', inviteId = '019ab4f0-0000-7000-8000-000000000003';
const person = { id: memberId, householdId: homeId, firstName: 'Alex', lastName: 'Smith', email: null, phone: null, photoKey: null, dateOfBirth: '1990-01-01',
  status: 'active', emergencyContacts: [], emailOptOut: false, emailDeliverable: true, anonymizedAt: null, revision: 1, createdAt: '2026-10-22T12:00:00Z' };
const invitation = { id: inviteId, scope: 'member', memberId, memberName: 'Alex Smith', email: 'alex@example.test', expiresAt: '2026-11-04T12:00:00.000Z' };
let outstanding: unknown[] = [], fail = false, listFails = false;
const calls: [string, string][] = [];
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push([method, path]);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/members/' + memberId) return json({ data: person });
    if (path.includes('/portal-logins')) return json({ data: [], pagination: { limit: 20, offset: 0, total: 0 } });
    if (path === `/api/households/${homeId}/portal-invitations` && method === 'GET') return listFails ? json({ error: { code: 'internal' } }, 500) : json({ data: outstanding });
    if (path === `/api/households/${homeId}/portal-invitations/${inviteId}` && method === 'DELETE') {
      if (fail) return json({ error: { code: 'not_found' } }, 404);
      outstanding = []; return json({ data: null });
    }
    return json({ error: { code: 'not_found' } }, 404);
  }));
}
function start() {
  const data: ShellBootstrap = { gym: { id: homeId, name: 'Test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: memberId, roles: ['front_desk'], member: false }, login: { password: true, magicLink: false } };
  vi.mocked(useBootstrap).mockReturnValue(new QueryObserver(new QueryClient(), { queryKey: ['bootstrap'], initialData: data, queryFn: async () => data }).getCurrentResult());
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PortalAccessTab memberId={memberId}/></QueryClientProvider>);
}
beforeEach(() => { outstanding = [invitation]; fail = false; listFails = false; calls.length = 0; stubFetch(); });
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

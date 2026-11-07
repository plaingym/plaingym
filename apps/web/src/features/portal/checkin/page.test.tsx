// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { answer, portalTestCache, storedFor, stubHouseholdLists } from '../household/test-cache.test-helper.js';
import { ApiError } from '../../../lib/api.js';
import type { PortalClient } from '../schedule/client.js';
import { PortalCheckinPage } from './page.js';
import { qrDataUrl } from '../../../lib/qr.js';
vi.mock('../../../lib/qr.js', async (original) => ({ ...await original<typeof import('../../../lib/qr.js')>(), qrDataUrl: vi.fn() }));

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } } }) }));
const parent = '00000000-0000-7000-8000-000000000001', child = '00000000-0000-7000-8000-000000000002';
const code = 'pgci1_' + 'a'.repeat(43);
const client = { context: vi.fn(), members: vi.fn(), checkinCode: vi.fn(), regenerateCheckin: vi.fn() };
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('../../../lib/qr.js')>('../../../lib/qr.js');
  vi.mocked(qrDataUrl).mockImplementation(actual.qrDataUrl);
  for (const mock of Object.values(client)) mock.mockReset();
  client.context.mockResolvedValue(answer({ role: 'payer', householdId: parent, memberId: parent }));
  client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent' }]));
  client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: memberId === child ? null : code, version: 1, revision: 4 }));
  client.regenerateCheckin.mockImplementation(async (memberId: string) => answer({ memberId, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const page = () => render(<QueryClientProvider client={portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } })}>
  <PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);

describe('portal check-in code', () => {
  it('keeps the member picker and replacement action when drawing fails and recovers on replacement', async () => {
    vi.mocked(qrDataUrl).mockImplementationOnce(() => { throw new Error('Draw failed'); });
    const user = userEvent.setup(); page();
    expect((await screen.findByRole('alert')).textContent).toBe("We couldn't display the QR code. Please try replacing it or ask the front desk for help.");
    expect(screen.getByLabelText('Code for')).toBeDefined();
    expect(screen.queryByAltText('QR check-in code for Pat Parent')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    await user.click(screen.getByRole('button', { name: 'Replace code' }));
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it("shows a member's QR code and creates a child's first code", async () => {
    const user = userEvent.setup(); page();
    expect((await screen.findByAltText('QR check-in code for Pat Parent')).getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await user.selectOptions(screen.getByLabelText('Code for'), child);
    await screen.findByText(/There is no active check-in code/);
    await user.click(screen.getByRole('button', { name: 'Create a code' }));
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(client.regenerateCheckin).toHaveBeenCalledWith(child, 4, 'household');
  });
  it('replaces a code only after confirmation and reports a stale revision', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    expect(client.regenerateCheckin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Replace code' }));
    await screen.findByText(/The code changed on another device/);
    expect(client.checkinCode).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole('button', { name: 'Replace code' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(parent, 4, 'household');
  });
  it('explains an unavailable gym key without server details', async () => {
    client.checkinCode.mockRejectedValue(new ApiError(503, 'request_failed'));
    page();
    await screen.findByText(/Check-in codes aren't available right now/);
  });
  it('never shows a code answered for another household than the open one, and reads the household lists again', async () => {
    const reads = stubHouseholdLists(), cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } });
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }, 'other'));
    render(<QueryClientProvider client={cache}><PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);
    await screen.findByText("We couldn't load the check-in code. Please try again.");
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    expect(screen.queryByAltText(/QR check-in code/)).toBeNull();
    expect(storedFor(cache, 'gym', 'user', 'household')).toEqual(['act-for', 'context']);
  });
  it('never shows a regenerated code answered for another household', async () => {
    const reads = stubHouseholdLists(), cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } });
    client.regenerateCheckin.mockImplementation(async (memberId: string) => answer({ memberId, code: 'pgci1_' + 'c'.repeat(43), version: 2, revision: 5 }, 'other'));
    const user = userEvent.setup();
    render(<QueryClientProvider client={cache}><PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(screen.queryByAltText('QR check-in code for Casey Parent')).toBeNull();
    expect(cache.getQueryCache().findAll().some(query => JSON.stringify(query.state.data ?? null).includes('c'.repeat(43)))).toBe(false);
  });
});

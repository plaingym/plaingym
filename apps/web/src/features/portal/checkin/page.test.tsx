// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../../../lib/api.js';
import type { PortalClient } from '../schedule/client.js';
import { PortalCheckinPage } from './page.js';

vi.mock('../../../app/context.js', () => ({ useBootstrap: () => ({ data: { gym: { id: 'gym', timezone: 'UTC' }, session: { userId: 'user' } } }) }));
const parent = '00000000-0000-7000-8000-000000000001', child = '00000000-0000-7000-8000-000000000002';
const code = 'pgci1_' + 'a'.repeat(43);
const client = { context: vi.fn(), members: vi.fn(), checkinCode: vi.fn(), regenerateCheckin: vi.fn() };
beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset();
  client.context.mockResolvedValue({ role: 'payer', householdId: parent, memberId: parent });
  client.members.mockResolvedValue([{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent' }]);
  client.checkinCode.mockImplementation(async (memberId: string) => ({ memberId, code: memberId === child ? null : code, version: 1, revision: 4 }));
  client.regenerateCheckin.mockImplementation(async (memberId: string) => ({ memberId, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 }));
});
afterEach(cleanup);
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);

describe('portal check-in code', () => {
  it("shows a member's QR code and creates a child's first code", async () => {
    const user = userEvent.setup(); page();
    expect((await screen.findByAltText('QR check-in code for Pat Parent')).getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    await user.selectOptions(screen.getByLabelText('Code for'), child);
    await screen.findByText(/There is no active check-in code/);
    await user.click(screen.getByRole('button', { name: 'Create a code' }));
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(client.regenerateCheckin).toHaveBeenCalledWith(child, 4);
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
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(parent, 4);
  });
  it('explains an unavailable gym key without server details', async () => {
    client.checkinCode.mockRejectedValue(new ApiError(503, 'request_failed'));
    page();
    await screen.findByText(/Check-in codes aren't available right now/);
  });
});

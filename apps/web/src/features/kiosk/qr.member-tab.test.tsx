// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CheckinCodePanel } from './qr.member-tab.js';
import { QrRequestError, staffCheckinCode } from './qr.api.js';
import { qrDataUrl } from '../../lib/qr.js';
vi.mock('../../lib/qr.js', async (original) => ({ ...await original<typeof import('../../lib/qr.js')>(), qrDataUrl: vi.fn() }));
vi.mock('./qr.api.js', async (original) => ({ ...await original<typeof import('./qr.api.js')>(), staffCheckinCode: vi.fn() }));
const initial = { memberId: 'member', version: 1, revision: 1, code: null };
beforeEach(async () => {
  vi.mocked(staffCheckinCode).mockResolvedValue(initial);
  const actual = await vi.importActual<typeof import('../../lib/qr.js')>('../../lib/qr.js');
  vi.mocked(qrDataUrl).mockImplementation(actual.qrDataUrl);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CheckinCodePanel gymId="gym" memberId="member"/></QueryClientProvider>);
  return client;
}
it('shows a drawing failure inline and keeps replace and revoke available, then clears it for a new code', async () => {
  vi.mocked(staffCheckinCode).mockResolvedValue({ ...initial, code: 'code' });
  vi.mocked(qrDataUrl).mockImplementationOnce(() => { throw new Error('Draw failed'); });
  setup();
  expect((await screen.findByRole('alert')).textContent).toBe("We couldn't display the QR code. Please try replacing it or ask the front desk for help.");
  expect(screen.getByRole('alert').closest('dialog')).toBeNull();
  expect(screen.queryByAltText('Member check-in QR code')).toBeNull();
  expect(screen.getByRole('button', { name: 'Revoke check-in code' })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Replace check-in code' }));
  vi.mocked(staffCheckinCode).mockResolvedValueOnce({ ...initial, revision: 2, code: 'replacement' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  await screen.findByAltText('Member check-in QR code');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('creates, shows, replaces and revokes a code with revision checking and explicit confirmation', async () => {
  setup(); await screen.findByText('No active check-in code. Create one to enable QR check-in.');
  fireEvent.click(screen.getByRole('button', { name: 'Create check-in code' }));
  expect(staffCheckinCode).toHaveBeenCalledTimes(1);
  vi.mocked(staffCheckinCode).mockResolvedValueOnce({ ...initial, version: 2, revision: 2, code: 'code' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  expect(staffCheckinCode).toHaveBeenLastCalledWith('member', 'regenerate', 1);
  await screen.findByAltText('Member check-in QR code');
  fireEvent.click(screen.getByRole('button', { name: 'Replace check-in code' }));
  vi.mocked(staffCheckinCode).mockResolvedValueOnce({ ...initial, version: 3, revision: 3, code: 'replacement' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  expect(staffCheckinCode).toHaveBeenLastCalledWith('member', 'regenerate', 2);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke check-in code' }));
  vi.mocked(staffCheckinCode).mockResolvedValueOnce({ ...initial, version: 4, revision: 4 });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  expect(staffCheckinCode).toHaveBeenLastCalledWith('member', 'revoke', 3);
  await waitFor(() => expect(screen.queryByAltText('Member check-in QR code')).toBeNull());
});
it('reloads the latest revision on conflict and keeps the error inside the dialog', async () => {
  setup(); await screen.findByRole('button', { name: 'Create check-in code' });
  fireEvent.click(screen.getByRole('button', { name: 'Create check-in code' }));
  vi.mocked(staffCheckinCode).mockRejectedValueOnce(new QrRequestError(409)).mockResolvedValueOnce({ ...initial, revision: 2 });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  const error = await screen.findByRole('alert');
  expect(error.closest('dialog')).not.toBeNull(); expect(error.textContent).toContain('latest version');
  vi.mocked(staffCheckinCode).mockResolvedValueOnce({ ...initial, version: 2, revision: 3, code: 'new' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm' })); });
  expect(staffCheckinCode).toHaveBeenLastCalledWith('member', 'regenerate', 2);
});

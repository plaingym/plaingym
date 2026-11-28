// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager, onlineManager, QueryClientProvider } from '@tanstack/react-query';
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
afterEach(() => { cleanup(); vi.unstubAllGlobals(); onlineManager.setOnline(true); focusManager.setFocused(undefined); });
const page = () => render(<QueryClientProvider client={portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } })}>
  <PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);
const replace = () => screen.getByRole('button', { name: 'Replace code' }) as HTMLButtonElement;
const replaceError = "We couldn't replace the check-in code. Please try again.";
const conflict = 'The code changed on another device. The latest code is shown; try again if you still want to replace it.';
const conflictReading = 'The code changed on another device. The latest code shows once it has been read; then try again if you still want to replace it.';
const rereading = "This code may have been replaced, so it's hidden until it has been read again. That needs a connection.";
const waiting = 'Replace code turns back on once the current code has been read again. That needs a connection.';
const createError = "We couldn't create a check-in code. Please try again.";
const createRereading = 'A code may have been created, so this page waits until the code has been read again. That needs a connection.';
const inactive = 'There is no active check-in code. Create one to check in with the kiosk camera.';

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
    expect(screen.getByAltText('QR check-in code for Pat Parent').classList.contains('bg-white')).toBe(true);
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
  it('frees the dialog at once after a replacement fails offline, and waits for the code to be read before another', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    onlineManager.setOnline(false);
    await user.click(screen.getByRole('button', { name: 'Replace code' }));
    expect((await screen.findByRole('alert')).textContent).toBe(replaceError);
    // The dialog's Close and its Keep button share a label.
    const keep = screen.getAllByRole('button', { name: 'Keep the current code' }) as HTMLButtonElement[];
    expect(replace().disabled).toBe(true);
    expect(screen.getByText(waiting)).toBeDefined();
    expect(keep.map(button => button.disabled)).toEqual([false, false]);
    await user.click(keep.at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    const again = screen.getByRole('button', { name: 'Replace this code' }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    // The server may have replaced the code, so the old one isn't shown while it can't be read.
    expect(screen.getByText(rereading)).toBeDefined();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/screen brightness/)).toBeNull();
    expect(client.checkinCode).toHaveBeenCalledTimes(1);
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 }));
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(again.disabled).toBe(false));
    expect(screen.getByAltText('QR check-in code for Pat Parent')).toBeDefined();
    expect(screen.queryByText(rereading)).toBeNull();
    // The failed attempt stays reported until the next one.
    expect(screen.getByRole('alert').textContent).toBe(replaceError);
    expect(client.checkinCode).toHaveBeenCalledTimes(2);
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(1);
  });
  it('keeps replacement off after the re-read fails, and says the latest code is shown only once it is', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    let fail!: (cause: unknown) => void;
    client.checkinCode.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    await user.click(replace());
    expect((await screen.findByRole('alert')).textContent).toBe(conflictReading);
    expect(replace().disabled).toBe(true);
    await act(async () => fail(new ApiError(500, 'request_failed')));
    // The page behind the dialog offers a retry too; the dialog's is the one a press can reach.
    const retry = await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' });
    expect(replace().disabled).toBe(true);
    expect(screen.getByText(waiting)).toBeDefined();
    expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe(conflictReading);
    expect(screen.queryByRole('img')).toBeNull();
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: 'pgci1_' + 'b'.repeat(43), version: 3, revision: 6 }));
    await user.click(retry);
    await waitFor(() => expect(replace().disabled).toBe(false));
    expect(screen.queryByText(waiting)).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(conflict);
    await user.click(replace());
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(2);
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(parent, 6, 'household');
  });
  it('says the latest code is shown after a conflict whose re-read succeeds', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(conflict));
    expect(client.checkinCode).toHaveBeenCalledTimes(2);
    expect(replace().disabled).toBe(false);
    expect(screen.queryByText(waiting)).toBeNull();
  });
  it("lets another member create a code while one member's re-read still waits", async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    // The parent's re-read, answered by nothing, waits for as long as the test runs.
    client.checkinCode.mockImplementationOnce(() => new Promise(() => undefined));
    await user.click(replace());
    await screen.findByText(waiting);
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect((screen.getByRole('button', { name: 'Replace this code' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(screen.getByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(create);
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(child, 4, 'household');
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(2);
  });
  it('says nothing on another member about a creation that fails after the member was changed', async () => {
    let fail!: (cause: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    await user.selectOptions(screen.getByLabelText('Code for'), parent);
    await screen.findByAltText('QR check-in code for Pat Parent');
    const reads = client.checkinCode.mock.calls.length;
    await act(async () => fail(new ApiError(409, 'request_failed')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByAltText('QR check-in code for Pat Parent')).toBeDefined();
    expect((screen.getByRole('button', { name: 'Replace this code' }) as HTMLButtonElement).disabled).toBe(false);
    expect(client.checkinCode).toHaveBeenCalledTimes(reads);
    await user.selectOptions(screen.getByLabelText('Code for'), child);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Create a code' }) as HTMLButtonElement).disabled).toBe(false));
    expect(client.checkinCode).toHaveBeenLastCalledWith(child, 'household');
    expect(client.checkinCode).toHaveBeenCalledTimes(reads + 1);
  });
  it('closes the confirmation when its member leaves the list and the replacement then fails', async () => {
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }));
    let fail!: (cause: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    client.members.mockResolvedValue(answer([{ id: child, name: 'Casey Parent' }]));
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByAltText('QR check-in code for Casey Parent');
    await act(async () => fail(new TypeError('Failed to fetch')));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(1);
  });
  it('reports a failed creation as one, and says why creating waits until the code has been read again', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' }) as HTMLButtonElement;
    const reads = client.checkinCode.mock.calls.length;
    onlineManager.setOnline(false);
    await user.click(create);
    expect((await screen.findByRole('alert')).textContent).toBe(createError);
    expect(screen.queryByText(replaceError)).toBeNull();
    expect(screen.getByText(createRereading)).toBeDefined();
    expect(screen.queryByText(inactive)).toBeNull();
    expect(create.disabled).toBe(true);
    expect(client.checkinCode).toHaveBeenCalledTimes(reads);
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(create.disabled).toBe(false));
    expect(screen.getByText(inactive)).toBeDefined();
    expect(screen.queryByText(createRereading)).toBeNull();
    expect(client.checkinCode).toHaveBeenCalledTimes(reads + 1);
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(1);
  });
  const made = async (memberId: string) => answer({ memberId, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 });
  it('drops the failed creation message, and moves its focus to the button, once the re-read finds a code', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' });
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(made(memberId)); }));
    await user.click(create);
    const message = await screen.findByRole('alert');
    expect(message.textContent).toBe(createError);
    expect(document.activeElement).toBe(message);
    await act(async () => read());
    await screen.findByAltText('QR check-in code for Casey Parent');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(createError)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace this code' }));
  });
  it('drops the failed creation message without moving the focus held elsewhere', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' });
    client.checkinCode.mockImplementationOnce(made);
    onlineManager.setOnline(false);
    await user.click(create);
    expect((await screen.findByRole('alert')).textContent).toBe(createError);
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    act(() => onlineManager.setOnline(true));
    await screen.findByAltText('QR check-in code for Casey Parent');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(document.activeElement).toBe(picker);
  });
  // A first code's creation fails, and so does the read that follows it.
  const failedCreationAndRead = async () => {
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' });
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    client.checkinCode.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(create);
    await screen.findByText("We couldn't load the check-in code. Please try again.");
    expect(screen.queryByText(createError)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    return picker;
  };
  const refocus = () => act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
  it('never brings back a failed creation message when a read after a failed one finds a code', async () => {
    const picker = await failedCreationAndRead();
    client.checkinCode.mockImplementationOnce(made);
    refocus();
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(screen.queryByText(createError)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(picker);
  });
  it('never brings back a failed creation message when a read after a failed one finds no code', async () => {
    const picker = await failedCreationAndRead();
    client.checkinCode.mockImplementationOnce(async () => answer({ memberId: child, code: null, version: 1, revision: 4 }));
    refocus();
    await screen.findByText(inactive);
    expect(screen.queryByText(createError)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button', { name: 'Create a code' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(picker);
  });
  it('reports a failed creation when the read that failed was made while it was being sent', async () => {
    let fail!: (cause: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    client.checkinCode.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    refocus();
    await screen.findByText("We couldn't load the check-in code. Please try again.");
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(answer({ memberId, code: null, version: 1, revision: 4 })); }));
    await act(async () => fail(new TypeError('Failed to fetch')));
    await act(async () => read());
    await screen.findByText(inactive);
    expect(screen.getByRole('alert').textContent).toBe(createError);
  });
  it('never brings back a refused creation conflict when a read after a failed one finds a code', async () => {
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    const create = await screen.findByRole('button', { name: 'Create a code' });
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    client.checkinCode.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await user.click(create);
    await screen.findByText("We couldn't load the check-in code. Please try again.");
    expect(screen.queryByText(conflict)).toBeNull();
    expect(screen.queryByText(conflictReading)).toBeNull();
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    client.checkinCode.mockImplementationOnce(made);
    refocus();
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(picker);
  });
  it.each([
    ['failed replacement', new TypeError('Failed to fetch'), replaceError],
    ['refused replacement', new ApiError(409, 'request_failed'), conflictReading],
  ])('never brings back the message of a %s whose dialog was closed after a failed re-read', async (_name, cause, message) => {
    client.regenerateCheckin.mockRejectedValueOnce(cause);
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    const dialog = within(screen.getByRole('dialog'));
    await dialog.findByRole('button', { name: 'Try again' });
    expect(dialog.getByRole('alert').textContent).toBe(message);
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText("We couldn't load the check-in code. Please try again.")).toBeDefined();
    expect(screen.queryByText(message)).toBeNull();
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    refocus();
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(picker);
  });
  it('shows the replaced code when a read still in flight answers after the replacement', async () => {
    const replaced = 'pgci1_' + 'b'.repeat(43);
    const user = userEvent.setup(); page();
    await screen.findByAltText('QR check-in code for Pat Parent');
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    let finish!: (value: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await user.click(replace());
    let read!: () => void;
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: replaced, version: 2, revision: 5 }));
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(answer({ memberId, code, version: 1, revision: 4 })); }));
    refocus();
    await waitFor(() => expect(client.checkinCode).toHaveBeenCalledTimes(2));
    await act(async () => finish(answer({ memberId: parent, code: replaced, version: 2, revision: 5 })));
    await waitFor(() => expect(client.checkinCode).toHaveBeenCalledTimes(3));
    await act(async () => read());
    // The cache tells the page on a later timer, so a late answer would be drawn only after it.
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(qrDataUrl).mock.lastCall![0]).toBe(replaced);
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(parent, 5, 'household');
  });
  it('keeps the failed replacement message when the re-read answers with the same code', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    await waitFor(() => expect(replace().disabled).toBe(false));
    expect(client.checkinCode).toHaveBeenCalledTimes(2);
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.getByRole('alert').textContent).toBe(replaceError);
  });
  it('reads the code again from the dialog after a failed re-read', async () => {
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByRole('button', { name: 'Try again' })).toBeNull();
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    const retry = await dialog.findByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    expect(dialog.getByText(waiting)).toBeDefined();
    expect(replace().disabled).toBe(true);
    await waitFor(() => expect(retry.disabled).toBe(false));
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(answer({ memberId, code, version: 2, revision: 5 })); }));
    const reads = client.checkinCode.mock.calls.length;
    await user.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    expect(client.checkinCode).toHaveBeenCalledTimes(reads + 1);
    await act(async () => read());
    await waitFor(() => expect(replace().disabled).toBe(false));
    expect(dialog.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(dialog.queryByText(waiting)).toBeNull();
    expect(client.checkinCode).toHaveBeenCalledTimes(reads + 1);
    expect(client.regenerateCheckin).toHaveBeenCalledTimes(1);
  });
  it('closes the confirmation, sending nothing, when its member leaves the list', async () => {
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }));
    const both = [{ id: parent, name: 'Pat Parent' }, { id: child, name: 'Casey Parent' }];
    const reread = () => act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await screen.findByAltText('QR check-in code for Casey Parent');
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    expect(screen.getByRole('dialog')).toBeDefined();
    client.members.mockResolvedValue(answer(both.slice(0, 1)));
    reread();
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.queryByRole('dialog')).toBeNull();
    // The page returns to the chosen member once the list names them again; the closed confirmation stays closed.
    client.members.mockResolvedValue(answer(both));
    reread();
    await screen.findByAltText('QR check-in code for Casey Parent');
    expect(screen.queryByRole('dialog')).toBeNull();
    client.members.mockResolvedValue(answer(both.slice(0, 1)));
    reread();
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(client.regenerateCheckin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    expect(client.regenerateCheckin).toHaveBeenCalledExactlyOnceWith(parent, 4, 'household');
  });
  it('drops a reported failure when its member leaves the list', async () => {
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }));
    client.regenerateCheckin.mockRejectedValueOnce(new ApiError(409, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(conflict));
    client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }]));
    act(() => { focusManager.setFocused(false); focusManager.setFocused(true); });
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
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
  it('reads the code again after a read still in flight is cancelled for the replacement', async () => {
    const newer = 'pgci1_' + 'c'.repeat(43);
    const user = userEvent.setup(); page();
    await screen.findByAltText('QR check-in code for Pat Parent');
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    let finish!: (value: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await user.click(replace());
    // The read in flight and the ones after it are answered after a newer change.
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: newer, version: 3, revision: 6 }));
    client.checkinCode.mockImplementationOnce(() => new Promise(() => undefined));
    refocus();
    await waitFor(() => expect(client.checkinCode).toHaveBeenCalledTimes(2));
    await act(async () => finish(answer({ memberId: parent, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 })));
    await waitFor(() => expect(vi.mocked(qrDataUrl).mock.lastCall![0]).toBe(newer));
    expect(client.checkinCode).toHaveBeenCalledTimes(3);
  });
  it("starts a failed creation's re-read afresh instead of joining a read already in flight", async () => {
    let fail!: (cause: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    await user.selectOptions(screen.getByLabelText('Code for'), parent);
    await screen.findByAltText('QR check-in code for Pat Parent');
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(answer({ memberId, code: null, version: 1, revision: 4 })); }));
    const reads = client.checkinCode.mock.calls.length;
    await user.selectOptions(screen.getByLabelText('Code for'), child);
    await waitFor(() => expect(client.checkinCode).toHaveBeenCalledTimes(reads + 1));
    client.checkinCode.mockImplementation(made);
    await act(async () => fail(new TypeError('Failed to fetch')));
    await act(async () => read());
    await screen.findByAltText('QR check-in code for Casey Parent');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(inactive)).toBeNull();
  });
  it.each(['another member is chosen', 'the page is left'])('keeps no code that is answered after %s', async (away) => {
    const cache = portalTestCache('gym', 'user', 'household', { defaultOptions: { queries: { retry: false } } });
    let finish!: (value: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup();
    const view = render(<QueryClientProvider client={cache}><PortalCheckinPage client={client as unknown as PortalClient} /></QueryClientProvider>);
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    if (away === 'the page is left') view.unmount();
    else {
      await user.selectOptions(screen.getByLabelText('Code for'), parent);
      await screen.findByAltText('QR check-in code for Pat Parent');
    }
    // The child's unread query is collected before the answer arrives.
    const childRead = () => cache.getQueryCache().findAll().filter(query => query.queryKey.includes(child));
    await waitFor(() => expect(childRead()).toHaveLength(0));
    await act(async () => finish(answer({ memberId: child, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 })));
    expect(cache.getQueryCache().findAll().some(query => JSON.stringify(query.state.data ?? null).includes('b'.repeat(43)))).toBe(false);
  });
  it.each([
    ['dialog close', 0],
    ['Keep', -1],
  ])("puts the focus on the page's retry when the %s button closes the dialog while the read is in error", async (_name, index) => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' });
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(index)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));
  });
  it('puts the focus on the replace button when the code failed and was read again while the dialog was open', async () => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    refocus();
    await user.click(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(replace().disabled).toBe(false));
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace this code' }));
  });
  it('returns the focus to the button that opened the dialog when the code is fine', async () => {
    const user = userEvent.setup(); page();
    const opener = await screen.findByRole('button', { name: 'Replace this code' });
    await user.click(opener);
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
  it('keeps a newer code that a read fetched before an older replacement answer arrives', async () => {
    const newer = 'pgci1_' + 'c'.repeat(43);
    const user = userEvent.setup(); page();
    await screen.findByAltText('QR check-in code for Pat Parent');
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    let finish!: (value: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code: newer, version: 3, revision: 6 }));
    await user.click(replace());
    refocus();
    await waitFor(() => expect(vi.mocked(qrDataUrl).mock.lastCall![0]).toBe(newer));
    await act(async () => finish(answer({ memberId: parent, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 })));
    // The cache tells the page on a later timer, so an older answer would be drawn only after it.
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(vi.mocked(qrDataUrl).mock.lastCall![0]).toBe(newer);
    await user.click(screen.getByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    expect(client.regenerateCheckin).toHaveBeenLastCalledWith(parent, 6, 'household');
  });
  it("moves the focus to the replace button when the page's retry reads the code", async () => {
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace this code' }));
  });
  it("moves the focus to the new retry when the page's retry fails too", async () => {
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    let fail!: (cause: unknown) => void;
    client.checkinCode.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const user = userEvent.setup(); page();
    const first = await screen.findByRole('button', { name: 'Try again' });
    await user.click(first);
    await waitFor(() => expect(first.isConnected).toBe(false));
    await act(async () => fail(new ApiError(500, 'request_failed')));
    const next = await screen.findByRole('button', { name: 'Try again' });
    expect(document.activeElement).toBe(next);
  });
  it("moves the focus to the replace button when the page's retry goes away after the dialog closes", async () => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    const retry = await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(made(memberId)); }));
    await user.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => read());
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replace this code' }));
  });
  // The dialog gives the focus back to the button that opened it.
  const closedOnReplace = async () => {
    const user = userEvent.setup(); page();
    const opener = await screen.findByRole('button', { name: 'Replace this code' });
    await user.click(opener);
    await user.click(screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!);
    expect(document.activeElement).toBe(opener);
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
  };
  it("moves the focus to the page's retry when a failed read removes the focused button", async () => {
    await closedOnReplace();
    refocus();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    await waitFor(() => expect(document.activeElement).toBe(retry));
  });
  it('leaves the focus on the member picker when a failed read replaces the section', async () => {
    await closedOnReplace();
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    refocus();
    await screen.findByRole('button', { name: 'Try again' });
    expect(document.activeElement).toBe(picker);
  });
  // A browser drops the focus to the body when the focused button turns off. jsdom keeps it there, and ignores blur() on a
  // button that is off, so the button is turned on for the blur.
  const dropFocus = () => {
    const button = document.activeElement as HTMLButtonElement, off = button.disabled;
    act(() => { button.disabled = false; button.blur(); button.disabled = off; });
    expect(document.activeElement).toBe(document.body);
  };
  const replaceThis = () => screen.getByRole('button', { name: 'Replace this code' });
  const keep = () => screen.getAllByRole('button', { name: 'Keep the current code' }).at(-1)!;
  it('puts the focus on the replace button after a replacement', async () => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(replace());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(replaceThis()));
  });
  // The page tells the failure once the dialog closes, and that message takes the focus. Only a focus a press on empty
  // space has put on the body goes on to the section's button.
  it.each([
    ['keeps the focus on the failure message', false],
    ['gives the replace button the focus after a press on empty space', true],
  ])('%s when the code is read after a dialog closed during the re-read', async (_name, pressed) => {
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(made(memberId)); }));
    await user.click(replace());
    await screen.findByRole('alert');
    await user.click(keep());
    expect(screen.queryByRole('dialog')).toBeNull();
    const message = screen.getByRole('alert');
    expect(document.activeElement).toBe(message);
    if (pressed) act(() => message.blur());
    expect((replaceThis() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => read());
    await screen.findByAltText('QR check-in code for Pat Parent');
    await waitFor(() => expect((replaceThis() as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).toBe(pressed ? replaceThis() : message);
  });
  it('puts the focus on the replace button after a first code is created', async () => {
    let finish!: (value: unknown) => void;
    client.regenerateCheckin.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await user.click(await screen.findByRole('button', { name: 'Create a code' }));
    dropFocus();
    await act(async () => finish(answer({ memberId: child, code: 'pgci1_' + 'b'.repeat(43), version: 2, revision: 5 })));
    await screen.findByAltText('QR check-in code for Casey Parent');
    await waitFor(() => expect(document.activeElement).toBe(replaceThis()));
  });
  it("puts the focus on the dialog's keep button when its retry reads the code", async () => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    const retry = await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    let read!: () => void;
    client.checkinCode.mockImplementationOnce((memberId: string) => new Promise(resolve => { read = () => resolve(made(memberId)); }));
    await user.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    await act(async () => read());
    await waitFor(() => expect(retry.isConnected).toBe(false));
    expect(document.activeElement).toBe(keep());
  });
  /** Fails a replacement and the read after it, then starts the dialog's retry with a read the test answers itself. */
  const retryHeld = async () => {
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    client.regenerateCheckin.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    await user.click(replace());
    const retry = await within(screen.getByRole('dialog')).findByRole('button', { name: 'Try again' }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false));
    let fail!: () => void;
    client.checkinCode.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = () => reject(new ApiError(500, 'request_failed')); }));
    await user.click(retry);
    await waitFor(() => expect(retry.disabled).toBe(true));
    return { retry, fail: () => act(async () => fail()) };
  };
  it("gives the dialog's retry the focus back when the read fails again", async () => {
    const { retry, fail } = await retryHeld();
    dropFocus();
    await fail();
    await waitFor(() => expect(retry.disabled).toBe(false));
    expect(retry.isConnected).toBe(true);
    expect(document.activeElement).toBe(retry);
  });
  it('leaves the focus on another dialog control when the read fails again', async () => {
    const { retry, fail } = await retryHeld();
    act(() => keep().focus());
    await fail();
    await waitFor(() => expect(retry.disabled).toBe(false));
    // The effects of the failed read have run once this settles.
    await act(async () => undefined);
    expect(document.activeElement).toBe(keep());
  });
  it('puts the focus on the replace button when a members read drops the member of the open dialog', async () => {
    client.checkinCode.mockImplementation(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }));
    const user = userEvent.setup(); page();
    await user.selectOptions(await screen.findByLabelText('Code for'), child);
    await screen.findByAltText('QR check-in code for Casey Parent');
    await user.click(replaceThis());
    // A browser moves the focus into a dialog as it opens.
    act(() => keep().focus());
    client.members.mockResolvedValue(answer([{ id: parent, name: 'Pat Parent' }]));
    refocus();
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(replaceThis()));
  });
  it('leaves the focus on the body when a read fails after it was last outside the code', async () => {
    page();
    const button = await screen.findByRole('button', { name: 'Replace this code' });
    act(() => button.focus());
    act(() => button.blur());
    const picker = screen.getByLabelText('Code for');
    act(() => picker.focus());
    act(() => picker.blur());
    client.checkinCode.mockRejectedValueOnce(new ApiError(500, 'request_failed'));
    refocus();
    await screen.findByRole('button', { name: 'Try again' });
    // The view's effects have run once this settles.
    await act(async () => undefined);
    expect(document.activeElement).toBe(document.body);
  });
  it('moves no focus on the first load', async () => {
    page();
    await screen.findByAltText('QR check-in code for Pat Parent');
    expect(document.activeElement).toBe(document.body);
  });
  it("puts the focus on the page's retry once a household move that hid the failed read ends", async () => {
    let finish!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = () => resolve(new Response(null, { status: 503 })); })));
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: 'Replace this code' }));
    await user.click(keep());
    client.checkinCode.mockImplementationOnce(async (memberId: string) => answer({ memberId, code, version: 1, revision: 4 }, 'other'));
    refocus();
    // The page is hidden and inert while the household moves, and a browser gives nothing inside it the focus.
    // A hidden button has no accessible name, so it is found by its text.
    const retry = (await screen.findByText('Try again')).closest('button')!;
    expect(retry.closest('[inert]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(retry));
    dropFocus();
    await act(async () => finish());
    await waitFor(() => expect(retry.closest('[inert]')).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));
  });
});

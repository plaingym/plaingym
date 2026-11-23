// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { StaffRole } from '@plaingym/shared';
import { AnnouncementWorkspace, AnnouncementPage } from './page.js';
import { AnnouncementEditor } from './editor.js';
import { announcementClient, type Announcement, type AnnouncementClient } from './api.js';
import { ApiError } from '../../lib/api.js';
import { createRegistries } from '../../lib/registries.js';
import { visibleAdminNavigation } from '../../app/admin-shell.js';
import { ShellServicesContext } from '../../app/context.js';
import { createShellServices } from '../../app/services.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const id = '01900000-0000-7000-8000-000000000001', senderId = '01900000-0000-7000-8000-000000000002';
const program = { id, gymId: id, name: 'Adults', rankSystemId: null, active: true, revision: 1, createdAt: '2026-11-10T00:00:00Z' };
const announcement: Announcement = { id, createdBy: senderId, subject: 'Winter classes', body: 'Classes resume Monday.',
  audience: { statuses: ['active', 'trial', 'frozen'], programIds: [] }, recipientCount: 1200, status: 'sent',
  createdAt: '2026-11-10T00:00:00Z', completedAt: '2026-11-10T00:01:00Z', sent: 2400, failed: 3600, skipped: 4800,
  smsBody: null, smsRecipientCount: 0, smsSent: 0, smsFailed: 0, smsSkipped: 0, smsScheduledFor: null, smsCompletedAt: null };
function client(): AnnouncementClient {
  return { list: vi.fn(async () => ({ data: [announcement], pagination: { total: 1, offset: 0, limit: 20 } })),
    programs: vi.fn(async () => [program]), senders: vi.fn(async () => [{ id, userId: senderId, memberId: null, displayName: 'Jo Owner',
      bio: null, photoKey: null, rank: null, isPublic: false, revision: 1, createdAt: announcement.createdAt }]),
    preview: vi.fn(async () => ({ recipientCount: 1200, smsRecipientCount: 0, smsSegments: 0 })), test: vi.fn(async () => ({ sent: true as const })),
    testSms: vi.fn(async () => ({ sent: true as const })), send: vi.fn(async () => announcement) };
}
function provider(content: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>{content}</QueryClientProvider>);
}
function mount(service: AnnouncementClient) {
  return provider(<AnnouncementWorkspace gymId={id} gymName="Our Gym" timezone="America/Los_Angeles" client={service} />);
}
function editor(service: AnnouncementClient, owner = true) {
  return render(<AnnouncementEditor gymName="Our Gym" programs={[program]} client={service} owner={owner} close={vi.fn()} sent={vi.fn()} />);
}
it('shows long message counts and limits with English grouping', () => {
  editor(client());
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'x'.repeat(1234) } });
  expect(screen.getByText('1,234 / 10,000 characters')).toBeDefined();
});
it('uses the full text limit and permits confirmed texts with zero email recipients', async () => {
  const service = client(); vi.mocked(service.preview).mockResolvedValue({ recipientCount: 0, smsRecipientCount: 2, smsSegments: 1 });
  editor(service);
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Classes' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Email' } });
  await userEvent.click(screen.getByLabelText('Include a text message'));
  fireEvent.change(screen.getByLabelText('Text message'), { target: { value: 'x'.repeat(480) } });
  await userEvent.click(screen.getByRole('button', { name: 'Preview announcement' }));
  expect(service.preview).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('including the gym name and STOP line');
  fireEvent.change(screen.getByLabelText('Text message'), { target: { value: 'See you Monday.' } });
  await userEvent.click(screen.getByRole('button', { name: 'Preview announcement' }));
  expect(await screen.findByText('2 text recipients · 1 segments per recipient')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Continue to confirmation' }));
  await userEvent.click(screen.getByRole('button', { name: 'Send 0 emails and 2 texts' }));
  expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ sms: { body: 'See you Monday.' } }));
});
async function compose() {
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: ' Winter classes ' } });
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Classes resume Monday.\nBring water. <script>plain text</script>' } });
  await userEvent.click(screen.getByRole('button', { name: 'Preview announcement' }));
}
async function confirm() {
  await userEvent.click(await screen.findByRole('button', { name: 'Continue to confirmation' }));
  return screen.getByRole('button', { name: 'Send to 1,200 members' });
}

describe('announcement screens', () => {
  it('composes, previews escaped plain text, tests, confirms and returns to history', async () => {
    const service = client(); mount(service);
    await waitFor(() => expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(false));
    expect(await screen.findByText('Jo Owner')).toBeDefined();
    for (const count of ['2,400', '3,600', '4,800']) expect(screen.getByText(count)).toBeDefined();
    expect(screen.getByText(/Nov 9, 2026/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    expect((screen.getByRole('checkbox', { name: 'Active' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Frozen' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Adults' }));
    await compose();
    expect(service.preview).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Winter classes', audience: { statuses: ['active', 'trial'], programIds: [id] } }));
    const preview = await screen.findByRole('region', { name: 'Member message preview' });
    expect(preview.textContent).toContain('<script>plain text</script>'); expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('Our Gym'); expect(preview.textContent).toContain('Unsubscribe from announcements');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    expect(await screen.findByText('Test sent to your email address. No members received it.')).toBeDefined();
    expect(service.test).toHaveBeenCalledWith(vi.mocked(service.preview).mock.calls[0]![0]); expect(service.send).not.toHaveBeenCalled();
    await userEvent.click(await confirm());
    expect(await screen.findByText('Announcement accepted. Delivery progress appears in history.')).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(service.send).toHaveBeenCalledWith(expect.objectContaining({ confirm: true, sendGeneration: expect.stringMatching(/^[0-9a-f-]{36}$/) }));
  });

  it('disables confirm while sending, blocks double clicks and retains the same key after an uncertain result', async () => {
    const service = client(); let reject!: (error: Error) => void;
    service.send = vi.fn(() => new Promise<Announcement>((_resolve, no) => { reject = no; }));
    editor(service); await compose(); const button = await confirm();
    fireEvent.click(button); fireEvent.click(button);
    expect(service.send).toHaveBeenCalledTimes(1); expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Close announcement' }) as HTMLButtonElement).disabled).toBe(true);
    reject(new Error('private database error'));
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    expect(screen.getByRole('alert').textContent).not.toContain('private'); expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    vi.mocked(service.send).mockResolvedValue(announcement); fireEvent.click(screen.getByRole('button', { name: 'Send to 1,200 members' }));
    await waitFor(() => expect(service.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(service.send).mock.calls[1]![0]).toEqual(vi.mocked(service.send).mock.calls[0]![0]);
  });

  it('keeps the member confirmation label during a test send', async () => {
    const service = client(); let resolve!: (result: { sent: true }) => void;
    service.test = vi.fn(() => new Promise<{ sent: true }>(result => { resolve = result; }));
    editor(service); await compose(); await confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    expect((screen.getByRole('button', { name: 'Send to 1,200 members' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Sending…' })).toBeNull();
    expect(service.send).not.toHaveBeenCalled();
    resolve({ sent: true });
    expect(await screen.findByText('Test sent to your email address. No members received it.')).toBeDefined();
  });

  it.each(['disabled', 'no_smtp'] as const)('explains the %s preview refusal and links to settings', async reason => {
    const service = client(); service.preview = vi.fn(async () => { throw new ApiError(409, 'request_failed', [reason]); });
    editor(service); await compose();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reason === 'disabled' ? 'Member email is switched off' : 'Email is not set up for this gym');
    expect(within(alert).getByRole('link').getAttribute('href')).toBe('/admin/settings');
    expect(within(alert).getByRole('link').getAttribute('target')).toBe('_blank');
    expect(service.send).not.toHaveBeenCalled();
  });

  it('sends a validated compose draft to the sender while member email is off', async () => {
    const service = client(); service.preview = vi.fn(async () => { throw new ApiError(409, 'request_failed', ['disabled']); });
    editor(service); await compose();
    expect((await screen.findByRole('alert')).textContent).toContain('Member email is switched off');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    expect(await screen.findByText('Test sent to your email address. No members received it.')).toBeDefined();
    expect(service.test).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Winter classes' }));
    expect(service.send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Continue to confirmation' })).toBeNull();
  });

  it('validates a compose test before calling the server', async () => {
    const service = client(); editor(service);
    await userEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Enter a subject');
    expect(service.test).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404, 429, 503])('allows editing after a definite %s send refusal', async status => {
    const service = client(); service.send = vi.fn(async () => { throw new ApiError(status, 'request_failed'); });
    editor(service); await compose(); await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('announcement was not accepted');
    expect(screen.getByRole('button', { name: 'Edit message' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toContain('Winter classes');
  });

  it.each([
    [401, []], [403, []], [429, []], [503, []],
    [409, ['disabled']], [409, ['no_smtp']], [409, ['no_origin']],
  ] as const)('keeps an earlier uncertain send immutable after a %s retry refusal %s and reopening', async (status, reasons) => {
    const service = client();
    vi.mocked(service.send).mockRejectedValueOnce(new Error('Response lost'))
      .mockRejectedValueOnce(new ApiError(status, 'request_failed', reasons));
    mount(service);
    await waitFor(() => expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    await compose(); await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    for (let retry = 0; retry < 2; retry++) {
      await userEvent.click(screen.getByRole('button', { name: 'Close announcement' }));
      await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
      await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
      expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Send to 1,200 members' }));
      if (retry === 0) {
        expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
        expect(screen.getByRole('alert').textContent).not.toContain('announcement was not accepted');
        const reasonText = { disabled: 'Member email is switched off', no_smtp: 'The owner sets up SMTP', no_origin: 'canonical HTTPS gym address' };
        for (const reason of reasons) expect(screen.getByRole('alert').textContent).toContain(reasonText[reason]);
        expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
      }
    }
    expect(await screen.findByText('Announcement accepted. Delivery progress appears in history.')).toBeDefined();
    const calls = vi.mocked(service.send).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[1]![0]).toEqual(calls[0]![0]); expect(calls[2]![0]).toEqual(calls[0]![0]);
  });

  it('confirms starting over, clears the saved attempt across reopening, and sends with a new generation', async () => {
    const service = client();
    vi.mocked(service.send).mockRejectedValueOnce(new Error('Response lost'));
    mount(service);
    await waitFor(() => expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    await compose(); await userEvent.click(await confirm());
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByText(/Check announcement history first/).textContent).toContain('could mail members twice');
    expect(screen.queryByRole('button', { name: 'Send to 1,200 members' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep saved retry' }));
    await userEvent.click(screen.getByRole('button', { name: 'Keep saved retry' }));
    expect(screen.getByRole('button', { name: 'Send to 1,200 members' })).toBeDefined();
    expect(service.send).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear retry and compose' }));
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe(' Winter classes ');
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toContain('Bring water. <script>plain text</script>');
    expect(screen.queryByText(/This send may already have been accepted/)).toBeNull();
    // Reopening proves the workspace's retained attempt was also cleared.
    await userEvent.click(screen.getByRole('button', { name: 'Close announcement' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('');
    await compose(); await userEvent.click(await confirm());
    expect(await screen.findByText('Announcement accepted. Delivery progress appears in history.')).toBeDefined();
    const calls = vi.mocked(service.send).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]![0].sendGeneration).not.toBe(calls[0]![0].sendGeneration);
  });

  it('allows editing after a first refusal, then retains a new attempt once its outcome is uncertain', async () => {
    const service = client();
    vi.mocked(service.send).mockRejectedValueOnce(new ApiError(503, 'request_failed'))
      .mockRejectedValueOnce(new Error('Response lost')).mockRejectedValueOnce(new ApiError(403, 'request_failed'));
    editor(service); await compose(); await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('announcement was not accepted');
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    await userEvent.click(screen.getByRole('button', { name: 'Preview announcement' }));
    await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    await userEvent.click(screen.getByRole('button', { name: 'Send to 1,200 members' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    const calls = vi.mocked(service.send).mock.calls;
    expect(calls[1]![0].sendGeneration).not.toBe(calls[0]![0].sendGeneration);
    expect(calls[2]![0]).toEqual(calls[1]![0]);
  });

  it('keeps a replay conflict immutable', async () => {
    const service = client(); service.send = vi.fn(async () => { throw new ApiError(409, 'request_failed'); });
    editor(service); await compose(); await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
  });

  it('retains the attempted draft and generation when an uncertain send is closed and reopened', async () => {
    const service = client(); service.send = vi.fn(async () => { throw new Error('Response lost'); });
    mount(service);
    await waitFor(() => expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    await compose(); await userEvent.click(await confirm());
    expect((await screen.findByRole('alert')).textContent).toContain('Retry this same announcement');
    await userEvent.click(screen.getByRole('button', { name: 'Close announcement' }));
    await userEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    expect(screen.getByRole('region', { name: 'Member message preview' }).textContent).toContain('Winter classes');
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Send to 1,200 members' }));
    await waitFor(() => expect(service.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(service.send).mock.calls[1]![0]).toEqual(vi.mocked(service.send).mock.calls[0]![0]);
  });

  it('explains a missing canonical origin and opens address settings in a separate tab', async () => {
    const service = client(); service.preview = vi.fn(async () => { throw new ApiError(409, 'request_failed', ['no_origin']); });
    editor(service); await compose();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('canonical HTTPS gym address');
    expect(within(alert).getByRole('link').getAttribute('target')).toBe('_blank');
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toContain('Winter classes');
  });

  it('shows SMTP guidance without an owner-only settings link to admins', async () => {
    const service = client(); service.preview = vi.fn(async () => { throw new ApiError(409, 'request_failed', ['no_smtp']); });
    editor(service, false); await compose();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The owner sets up SMTP');
    expect(within(alert).queryByRole('link')).toBeNull();
  });

  it('shows an SMTP test refusal and a member-email confirmation refusal inside the dialog', async () => {
    const service = client(); editor(service); await compose();
    service.test = vi.fn(async () => { throw new ApiError(409, 'request_failed', ['no_smtp']); });
    await userEvent.click(await screen.findByRole('button', { name: 'Send me a test' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Email is not set up for this gym');
    service.send = vi.fn(async () => { throw new ApiError(409, 'request_failed', ['disabled']); });
    await userEvent.click(await confirm());
    expect((await screen.findAllByRole('alert')).some(alert => alert.textContent?.includes('Member email is switched off'))).toBe(true);
    expect(screen.getByRole('dialog')).toBeDefined();
  });

  it('requires at least one status and displays character counts and limits', async () => {
    const service = client(); editor(service);
    expect(screen.getByLabelText('Subject').getAttribute('maxlength')).toBe('150');
    expect(screen.getByLabelText('Message').getAttribute('maxlength')).toBe('10000');
    for (const status of ['Active', 'Trial', 'Frozen']) await userEvent.click(screen.getByRole('checkbox', { name: status }));
    await compose(); expect((await screen.findByRole('alert')).textContent).toContain('at least one member status');
    expect(service.preview).not.toHaveBeenCalled(); expect(screen.getByText('16 / 150 characters')).toBeDefined();
  });

  it('blocks an empty audience and refreshes preview after editing', async () => {
    const service = client(); vi.mocked(service.preview).mockResolvedValueOnce({ recipientCount: 0, smsRecipientCount: 0, smsSegments: 0 });
    editor(service); await compose();
    expect((await screen.findByRole('button', { name: 'Continue to confirmation' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No eligible members/)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'New subject' } });
    await userEvent.click(screen.getByRole('button', { name: 'Preview announcement' }));
    expect(await screen.findByText('1,200 members will receive this announcement')).toBeDefined();
    expect(service.preview).toHaveBeenLastCalledWith(expect.objectContaining({ subject: 'New subject' }));
  });

  it('paginates newest-first server history and recovers from list failure', async () => {
    const service = client(); vi.mocked(service.list).mockRejectedValueOnce(new Error('private'));
    mount(service); const error = await screen.findByRole('alert');
    await userEvent.click(within(error).getByRole('button'));
    expect(await screen.findByText('Winter classes')).toBeDefined();
    vi.mocked(service.list).mockResolvedValue({ data: [announcement], pagination: { offset: 0, limit: 20, total: 21 } });
    // Refresh the already successful query through a remount.
    cleanup(); mount(service);
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(service.list).toHaveBeenCalledWith(20));
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(service.list).toHaveBeenLastCalledWith(0));
    expect(screen.getByText('Delivery complete')).toBeDefined();
  });

  it('shows an empty history and uses the sender account ID when no profile exists', async () => {
    const service = client(); vi.mocked(service.list).mockResolvedValueOnce({ data: [], pagination: { total: 0, limit: 20, offset: 0 } });
    mount(service); expect(await screen.findByText('No announcements yet')).toBeDefined();
    cleanup(); vi.mocked(service.senders).mockResolvedValue([]); mount(service);
    expect(await screen.findByText('Account ' + senderId)).toBeDefined();
  });

  it('polls history only while a shown announcement is still delivering', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const service = client();
      vi.mocked(service.list).mockResolvedValueOnce({ data: [{ ...announcement, status: 'sending' }], pagination: { total: 1, limit: 20, offset: 0 } });
      mount(service); expect(await screen.findByText('Delivery in progress')).toBeDefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect(await screen.findByText('Delivery complete')).toBeDefined();
      await vi.advanceTimersByTimeAsync(15000);
      expect(service.list).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('offers retry for program failures before allowing compose', async () => {
    const service = client(); vi.mocked(service.programs).mockRejectedValueOnce(new Error('private'));
    mount(service); const error = await screen.findByRole('alert');
    expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(error).getByRole('button'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'New announcement' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(['owner', 'admin', 'coach', 'front_desk'] as const)('gates the registered navigation for %s', role => {
    const session = { userId: senderId, displayName: 'Staff', email: 'staff@example.test', roles: [role], member: false };
    const visible = visibleAdminNavigation(createRegistries().adminNav.all(), session, []);
    expect(visible.some(entry => entry.href === '/admin/announcements')).toBe(role === 'owner' || role === 'admin');
  });

  it.each(['coach', 'front_desk'] as const)('denies direct page access to %s before loading announcements', async (role: StaffRole) => {
    const services = createShellServices(async () => ({ gym: { id, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: senderId, email: 'staff@example.test', displayName: null, roles: [role], member: false }, login: { password: true, magicLink: false } }));
    provider(<ShellServicesContext.Provider value={services}><AnnouncementPage /></ShellServicesContext.Provider>);
    expect(await screen.findByText('Only owners and admins can send announcements and view their history.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'New announcement' })).toBeNull();
  });

  it.each(['owner', 'admin'] as const)('composes the production page with the default client for %s', async role => {
    const service = client();
    const list = vi.spyOn(announcementClient, 'list').mockImplementation(service.list);
    vi.spyOn(announcementClient, 'programs').mockImplementation(service.programs);
    vi.spyOn(announcementClient, 'senders').mockImplementation(service.senders);
    const services = createShellServices(async () => ({ gym: { id, name: 'Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: senderId, email: 'staff@example.test', displayName: null, roles: [role], member: false }, login: { password: true, magicLink: false } }));
    provider(<ShellServicesContext.Provider value={services}><AnnouncementPage /></ShellServicesContext.Provider>);
    expect(await screen.findByText('Winter classes')).toBeDefined();
    expect(list).toHaveBeenCalledWith(0);
    await userEvent.click(screen.getByRole('button', { name: 'New announcement' }));
    expect(screen.getByRole('dialog')).toBeDefined();
  });
});

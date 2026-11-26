// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWebRegistries } from '@plaingym/shared';
import { ShellServicesContext } from '../../app/context.js';
import type { ShellServices } from '../../app/services.js';
import { ApiError, onApiError } from '../../lib/api.js';
import { SetupWizard } from './wizard.js';
import { fieldChecks, splitBucketAddress } from './checks.js';
import { createSetupClient } from './api.js';
import { createRegistries, type ExtensionView } from '../../lib/registries.js';

const services: ShellServices = {
  loadBootstrap: vi.fn(async () => ({ gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false }, login: { password: true, magicLink: false } })),
  signInWithPassword: vi.fn(async () => {}), requestMagicLink: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
};
const privateKey = 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';
const publicKey = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const restoreJob = '019a0af0-9c00-7000-8000-0000000000bb';
/** The faked server's next answers to restore polls, in order; once they run out, the restore is complete. */
let restorePolls: (() => Response | Promise<Response>)[] = [];
/** What the faked server answers to a status read instead of its own progress, when set. */
let statusAnswer: (() => Response | Promise<Response>) | null = null;
/** A faked setup server: its step, revision and the owner's recorded decisions, as `/api/setup` reports them. */
function start(step = 0, completedSteps = Array.from({ length: step }, (_, i) => i), registries = createRegistries(),
  recorded: { googleSkipped?: boolean; backupsLater?: boolean } = {}) {
  let currentStep = step, revision = 1, googleSkipped = recorded.googleSkipped ?? false, backupsLater = recorded.backupsLater ?? false;
  const status = () => ({ currentStep: backupsLater && currentStep === 7 ? 8 : currentStep, completedSteps, completed: false, revision, googleSkipped, backupsLater });
  const fetcher = vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
    const name = String(path), body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    if (name === '/api/setup' && statusAnswer) return statusAnswer();
    if (name === '/api/setup' || name === '/api/setup/start') {
      if (name.endsWith('start')) currentStep = 1;
      return Response.json({ data: status() });
    }
    if (name.endsWith('/catalog')) return Response.json({ data: [{ id: 'bjj', name: 'Brazilian Jiu-Jitsu', version: 1, summary: 'Programs and belt colors' }] });
    if (name.endsWith('/owner')) { currentStep = 2; return Response.json({ data: { userId: '019a0af0-9c00-7000-8000-000000000001' } }); }
    if (name.endsWith('/gym')) { currentStep = 3; revision++; return Response.json({ data: { ...body, revision } }); }
    if (name.endsWith('/packs')) { currentStep = 4; revision++; return Response.json({ data: { currentStep, completedSteps: [0, 1, 2, 3], completed: false, revision } }); }
    if (name.endsWith('/smtp')) { currentStep = 6; revision++; return Response.json({ data: { configured: body.choice === 'configure', test: body.choice === 'configure' ? 'sent' : 'not_sent', revision } }); }
    if (name.endsWith('/google')) { revision++; return Response.json({ data: { configured: true, check: 'accepted', revision } }); }
    if (name.endsWith('/decisions')) {
      revision++;
      if (body.decision === 'skip_google') googleSkipped = true; else backupsLater = body.decision === 'backups_later';
      return Response.json({ data: status() });
    }
    if (name.endsWith('/backups')) { revision++; return Response.json({ data: { privateKey, publicKey, revision } }); }
    if (name.endsWith('/backups/confirm')) {
      if (body.privateKey !== privateKey) return Response.json({ error: { code: 'invalid_request', message: 'Backup key does not match' } }, { status: 400 });
      currentStep = 8; completedSteps = [0, 1, 2, 3, 4, 5, 6, 7]; revision++;
      return Response.json({ data: { publicKey, confirmed: true, revision } });
    }
    if (name.endsWith('/stripe')) { currentStep = 7; revision++; return Response.json({ data: { configured: false, mode: null, webhookRegistered: false, revision } }); }
    if (name === '/api/setup/restore') return Response.json({ data: { status: 'running', jobId: restoreJob, phase: 'verifying' } });
    if (name.startsWith('/api/setup/restore/')) return restorePolls.length ? restorePolls.shift()!()
      : Response.json({ data: { status: 'restored', jobId: name.split('/').pop(), billingEnabled: false, next: 'login' } });
    if (name.endsWith('/finish')) return Response.json({ data: { completed: true, billingEnabled: false, memberEmailsEnabled: false, revision: ++revision } });
    return Response.json({}, { status: 500 });
  });
  const client = createSetupClient(fetcher as typeof fetch);
  // The registered step 8 component uses the global fetch.
  vi.stubGlobal('fetch', fetcher);
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={query}><ShellServicesContext.Provider value={services}><SetupWizard client={client} registries={registries} /></ShellServicesContext.Provider></QueryClientProvider>);
  return { fetcher, client, query };
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); restorePolls = []; statusAnswer = null; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('setup wizard', () => {
  it('reports a structured setup refusal once and keeps its reason codes on the thrown error', async () => {
    const reason = ['demo_showcase_read_only'], observe = vi.fn(), stop = onApiError(observe);
    const client = createSetupClient(async () => Response.json({ error: { details: { reason } } }, { status: 403 }));
    try {
      await expect(client.call('status')).rejects.toMatchObject({ status: 403, reason });
      expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 403, reason }));
    } finally { stop(); }
  });
  it('shows only the import Back action while choosing a CSV', async () => {
    start(8, [0, 1, 2, 3, 4, 5, 6], undefined, { backupsLater: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Import a CSV' }));
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Back to backups' })).toBeDefined();
  });
  it('keeps restore submit and Back together, and Back works without validating the restore form', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    const restore = within(actions).getByRole('button', { name: 'Restore a backup' });
    expect(restore.getAttribute('type')).toBe('submit');
    const back = within(actions).getByRole('button', { name: 'Back' });
    restore.focus(); await userEvent.tab();
    expect(document.activeElement).toBe(back);
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('button', { name: 'Start fresh' });
    expect(fetcher.mock.calls.some(([path]) => path === '/api/setup/restore')).toBe(false);
  });
  it('keeps email submit and skip in one bar and skipping works with empty required fields', async () => {
    const { fetcher } = start(5);
    await screen.findByRole('button', { name: 'Send test email and save' });
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    const submit = within(actions).getByRole('button', { name: 'Send test email and save' });
    expect(submit.getAttribute('type')).toBe('submit');
    const skip = within(actions).getByRole('button', { name: 'Skip email configuration' });
    expect(skip.getAttribute('type')).toBe('button');
    submit.focus(); await userEvent.tab();
    expect(document.activeElement).toBe(skip);
    await userEvent.keyboard('{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Skip Google sign-in' }));
    await screen.findByLabelText('Restricted Stripe key');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/smtp');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('says when the storage destination refused the backup step', async () => {
    const { fetcher } = start(7);
    const refused = () => Response.json({ error: { code: 'invalid_request', message: 'server detail', details: { destination: ['unreachable'] } } }, { status: 400 });
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/backups') ? Promise.resolve(refused()) : answer(path, options));
    await screen.findByRole('button', { name: 'Generate backup key' });
    await userEvent.type(screen.getByLabelText('S3-compatible endpoint URL'), 'https://s3.example.test');
    await userEvent.type(screen.getByLabelText('Storage bucket'), 'backups');
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Generate backup key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('list, write, read and delete');
    expect(document.body.textContent).not.toContain('server detail');
  });
  it('keeps backup setup-later, import finish and Back to backups in working action bars', async () => {
    const { fetcher } = start(7);
    await screen.findByRole('button', { name: 'Generate backup key' });
    const backupActions = screen.getByRole('group', { name: 'Setup actions' });
    expect(within(backupActions).getByRole('button', { name: 'Generate backup key' }).getAttribute('type')).toBe('submit');
    await userEvent.click(within(backupActions).getByRole('button', { name: 'Set up later' }));
    let actions = screen.getByRole('group', { name: 'Setup actions' });
    expect(within(actions).getByRole('button', { name: 'Start fresh' })).toBeDefined();
    await userEvent.click(within(actions).getByRole('button', { name: 'Back to backups' }));
    await screen.findByRole('button', { name: 'Generate backup key' });
    expect(fetcher.mock.calls.some(([path]) => path === '/api/setup/finish')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Set up later' }));
    actions = screen.getByRole('group', { name: 'Setup actions' });
    await userEvent.click(within(actions).getByRole('button', { name: 'Start fresh' }));
    await screen.findByText(/Setup is complete/);
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    // Set up later, Back to backups and Set up later again each recorded a decision.
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/setup/decisions').map(([, init]) => JSON.parse(String(init?.body)).decision))
      .toEqual(['backups_later', 'backups_now', 'backups_later']);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 4, skipBackups: true });
  });
  it('submits the owner form from its action bar', async () => {
    start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    const submit = within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' });
    expect(submit.getAttribute('type')).toBe('submit');
    await userEvent.click(submit);
    await screen.findByLabelText('Gym name');
    expect(services.signInWithPassword).toHaveBeenCalledWith('owner@example.org', 'owner-password-123');
  });
  it('keeps the unregistered payment fallback in an action bar and continues to backups', async () => {
    const { fetcher } = start(6, [0, 1, 2, 3, 4, 5], createWebRegistries<ExtensionView>([]), { googleSkipped: true });
    await screen.findByText('Payment configuration is not set up. Continue with billing paused.');
    const actions = screen.getByRole('group', { name: 'Setup actions' });
    await userEvent.click(within(actions).getByRole('button', { name: 'Save and continue' }));
    await screen.findByRole('button', { name: 'Generate backup key' });
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/stripe');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('takes the installer token out of the URL and sends it only on bootstrap actions', async () => {
    window.history.replaceState(null, '', '/setup#token=private-install-token');
    const { client, fetcher } = start();
    await screen.findByRole('button', { name: 'Start fresh' });
    expect(window.location.hash).toBe('');
    expect(sessionStorage.getItem('setup.token')).toBe('private-install-token');
    await client.call('start', { choice: 'fresh' });
    expect(fetcher).toHaveBeenCalledWith('/api/setup/start', expect.objectContaining({ headers: expect.objectContaining({ 'X-Setup-Token': 'private-install-token' }) }));
    expect(fetcher.mock.calls.find(([path]) => path === '/api/setup')?.[1]?.headers).not.toHaveProperty('X-Setup-Token');
  });
  it('renders the registered Stripe step at step 6', async () => {
    start(6, undefined, undefined, { googleSkipped: true });
    expect(await screen.findByLabelText('Restricted Stripe key')).toBeDefined();
    expect(screen.getByText('Step 7 / 9')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Validate and connect' })).toBeDefined();
  });
  it('holds the Stripe confirmation across a status refetch until Continue to backups, while skip moves on at once', async () => {
    const { fetcher, query } = start(6, undefined, undefined, { googleSkipped: true });
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/stripe') && JSON.parse(String(options?.body)).choice === 'configure'
      ? answer(path, options).then(async () => Response.json({ data: { configured: true, mode: 'test', webhookRegistered: true, revision: 2 } }))
      : answer(path, options));
    await userEvent.type(await screen.findByLabelText('Restricted Stripe key'), 'rk_test_SYNTHETIC');
    await userEvent.click(screen.getByRole('button', { name: 'Validate and connect' }));
    const webhookUrl = new URL('/webhooks/stripe', window.location.origin).href;
    expect((await screen.findByRole('status')).textContent).toBe(`Connected in test mode. Webhook registered at ${webhookUrl}.`);
    await act(async () => { await query.refetchQueries({ queryKey: ['setup', 'status'] }); });
    expect(screen.getByRole('status').textContent).toBe(`Connected in test mode. Webhook registered at ${webhookUrl}.`);
    expect(screen.queryByRole('button', { name: 'Generate backup key' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to backups' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
    cleanup();
    start(6, undefined, undefined, { googleSkipped: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
  });
  it('keeps the Stripe confirmation when a status refetch advances to step 7 mid-request, and Continue sends one status request', async () => {
    const { fetcher, query } = start(6, undefined, undefined, { googleSkipped: true });
    const answer = fetcher.getMockImplementation()!;
    let resolveStripe!: (response: Response) => void;
    let statusMoved = false;
    fetcher.mockImplementation((path, options) => {
      if (String(path).endsWith('/stripe') && JSON.parse(String(options?.body)).choice === 'configure') {
        statusMoved = true;
        return new Promise<Response>((resolve) => { resolveStripe = resolve; });
      }
      if (String(path) === '/api/setup' && statusMoved) {
        return Promise.resolve(Response.json({ data: { currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6], completed: false, revision: 2, googleSkipped: true, backupsLater: false } }));
      }
      return answer(path, options);
    });
    await userEvent.type(await screen.findByLabelText('Restricted Stripe key'), 'rk_test_SYNTHETIC');
    await userEvent.click(screen.getByRole('button', { name: 'Validate and connect' }));
    await waitFor(() => expect(resolveStripe).toBeDefined());
    await act(async () => { await query.refetchQueries({ queryKey: ['setup', 'status'] }); });
    await act(async () => { resolveStripe(Response.json({ data: { configured: true, mode: 'test', webhookRegistered: true, revision: 2 } })); });
    const webhookUrl = new URL('/webhooks/stripe', window.location.origin).href;
    expect((await screen.findByRole('status')).textContent).toBe(`Connected in test mode. Webhook registered at ${webhookUrl}.`);
    expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate backup key' })).toBeNull();
    const statusCallsBefore = fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length;
    await userEvent.click(screen.getByRole('button', { name: 'Continue to backups' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
    const statusCallsAfter = fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length;
    expect(statusCallsAfter - statusCallsBefore).toBe(1);
  });
  it('offers an optional Google page after email that stores the client and changes no step', async () => {
    const { fetcher, query } = start(6);
    await screen.findByLabelText('Client ID');
    expect(screen.getByRole('heading', { name: 'Google sign-in (optional)' })).toBeDefined();
    expect(screen.getByText('Step 6a / 9')).toBeDefined();
    expect(screen.getByText(window.location.origin + '/api/auth/callback/google')).toBeDefined();
    expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
    const secret = screen.getByLabelText('Client secret') as HTMLInputElement;
    expect(secret.type).toBe('password');
    const invalidate = vi.spyOn(query, 'invalidateQueries');
    await userEvent.type(screen.getByLabelText('Client ID'), ' wizard-client.apps.googleusercontent.com ');
    await userEvent.type(secret, 'wizard-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save Google client' }));
    // It stays on the page with Google's answer until the owner continues.
    expect((await screen.findByRole('status')).textContent).toMatch(/^Saved. Google accepted this client ID and secret..*sign out and sign in with Google once/);
    expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Google sign-in (optional)' })).toBeDefined();
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Continue' }));
    await screen.findByLabelText('Restricted Stripe key');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/google');
    expect(call?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ revision: 1, clientId: 'wizard-client.apps.googleusercontent.com', clientSecret: 'wizard-secret' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['shell', 'bootstrap'] });
    // The secret leaves only in that request: it is never written anywhere the browser keeps.
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('wizard-secret');
  });
  it('records a skipped Google page on the server, resumes past it, and never shows it when the install already has Google sign-in', async () => {
    const { fetcher } = start(6);
    await userEvent.click(await screen.findByRole('button', { name: 'Skip Google sign-in' }));
    await screen.findByLabelText('Restricted Stripe key');
    expect(fetcher.mock.calls.some(([path]) => path === '/api/setup/google')).toBe(false);
    const decision = fetcher.mock.calls.find(([path]) => path === '/api/setup/decisions');
    expect(decision?.[1]?.method).toBe('PUT');
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ revision: 1, decision: 'skip_google' });
    expect({ ...sessionStorage, ...localStorage }).not.toHaveProperty('setup.google');
    cleanup(); sessionStorage.clear();
    // A reopened wizard (a new browser, nothing kept locally) reads the decision from the server.
    start(6, undefined, undefined, { googleSkipped: true });
    expect(await screen.findByLabelText('Restricted Stripe key')).toBeDefined();
    cleanup();
    const original = vi.mocked(services.loadBootstrap).getMockImplementation()!;
    vi.mocked(services.loadBootstrap).mockImplementation(async () => ({ ...await original(), login: { password: true, magicLink: false, google: true } }));
    try {
      start(6);
      expect(await screen.findByLabelText('Restricted Stripe key')).toBeDefined();
      expect(screen.queryByRole('heading', { name: 'Google sign-in (optional)' })).toBeNull();
    } finally { vi.mocked(services.loadBootstrap).mockImplementation(original); }
  });
  it('offers setup later and finishes from step 8 without asking for S3 credentials', async () => {
    const { fetcher } = start(7);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    expect(await screen.findByText('Step 9 / 9')).toBeDefined();
    expect(fetcher.mock.calls.find(([path]) => path === '/api/setup/finish')).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: 'Start fresh' }));
    await screen.findByText(/Setup is complete/);
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 2, skipBackups: true });
  });
  it('sends the street address in the shared address shape and omits it when blank', async () => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Mat Academy');
    await userEvent.type(screen.getByLabelText('Street address'), ' 123 Main ');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Step 4 / 9');
    const gym = (index: number) => JSON.parse(String(fetcher.mock.calls.filter(([path]) => path === '/api/setup/gym')[index]?.[1]?.body)) as { address: unknown };
    expect(gym(0).address).toEqual({ line1: '123 Main' });
    cleanup();
    const blank = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Mat Academy');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Step 4 / 9');
    const call = blank.fetcher.mock.calls.find(([path]) => path === '/api/setup/gym');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ address: {} });
  });
  describe('timezone field', () => {
    const real = Intl.DateTimeFormat;
    // Only the zone the no-argument call reports is replaced; the formatter is otherwise real, as are those the gym timezone schema builds.
    let spy: { mockRestore: () => void } | undefined;
    let hostReads = 0;
    const hostZone = (timeZone: string | undefined) => {
      hostReads = 0;
      const stub = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: unknown[]) {
        const formatter = new (real as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
        if (args.length) return formatter;
        hostReads += 1;
        const options = formatter.resolvedOptions();
        return Object.assign(formatter, { resolvedOptions: () => ({ ...options, timeZone: timeZone as string }) });
      } as unknown as typeof Intl.DateTimeFormat);
      // Code that calls the constructor's statics must still work under the stub.
      Object.assign(Intl.DateTimeFormat, { supportedLocalesOf: real.supportedLocalesOf.bind(real) });
      spy = stub;
    };
    afterEach(() => spy?.mockRestore());
    const hint = /couldn't use your browser's timezone/;
    it.each([
      ['uses a valid host zone without a hint', 'America/Vancouver', 'America/Vancouver', false],
      ['falls back to UTC with a hint when the host reports no zone', undefined, 'UTC', true],
      ['falls back to UTC with a hint when the host zone is unknown', 'Mars/Olympus_Mons', 'UTC', true],
      // Intl knows `CET`, but the gym step's request refuses a zone without a region.
      ['falls back to UTC with a hint when the gym step would refuse the host zone', 'CET', 'UTC', true],
    ])('%s', async (_name, zone, expected, hinted) => {
      hostZone(zone);
      start(2);
      const input = (await screen.findByLabelText('Timezone')) as HTMLInputElement;
      expect(input.value).toBe(expected);
      expect(!!screen.queryByText(hint)).toBe(hinted);
      expect(input.getAttribute('aria-describedby')).not.toBeNull();
      if (!hinted) expect(screen.getByText('For example, America/Vancouver or Europe/London.')).toBeDefined();
    });
    it('drops the fallback hint once the owner edits the field', async () => {
      hostZone(undefined);
      start(2);
      const input = await screen.findByLabelText('Timezone');
      expect(screen.queryByText(hint)).not.toBeNull();
      await userEvent.type(input, '/Vancouver');
      expect(screen.queryByText(hint)).toBeNull();
    });
    it('reads the host zone once per wizard mount', async () => {
      hostZone('America/Vancouver');
      start(2);
      const input = await screen.findByLabelText('Timezone');
      await userEvent.type(input, 'x');
      await userEvent.type(screen.getByLabelText('Gym name'), 'Academy');
      expect(hostReads).toBe(1);
    });
  });
  it('returns from step 8 to the backup step when backups were deferred', async () => {
    start(7);
    await userEvent.click(await screen.findByRole('button', { name: 'Set up later' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Back to backups' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
  });
  it('starts without asking for a gym bootstrap, then signs in the newly created owner', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(services.loadBootstrap).not.toHaveBeenCalled();
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByLabelText('Gym name');
    expect(services.signInWithPassword).toHaveBeenCalledWith('owner@example.org', 'owner-password-123');
    expect(fetcher).toHaveBeenCalledWith('/api/setup/owner', expect.objectContaining({ credentials: 'same-origin' }));
    expect(screen.queryByLabelText('Password (12–128 characters)')).toBeNull();
  });
  it('loads the shipped pack catalog and submits IDs with versions', async () => {
    const { fetcher } = start(3);
    await userEvent.click(await screen.findByRole('checkbox', { name: /Brazilian Jiu-Jitsu/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Use the built-in website');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/packs');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ revision: 1, packs: [{ packId: 'bjj', version: 1 }] });
  });
  it('explains relay delivery and permits skipping SMTP without erasing fallback settings', async () => {
    const { fetcher } = start(5);
    await screen.findByText(/Connect your email sending service/);
    expect(screen.getByText(/SPF and DKIM/)).toBeDefined();
    expect(screen.getByText(/Email-link sign-in becomes available/)).toBeDefined();
    await userEvent.click(await screen.findByRole('button', { name: 'Skip email configuration' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Skip Google sign-in' }));
    await screen.findByLabelText('Restricted Stripe key');
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/smtp');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'skip', revision: 1 });
  });
  it('requires backup key confirmation before allowing setup to finish', async () => {
    start(7);
    await screen.findByRole('button', { name: 'Generate backup key' });
    expect(screen.queryByRole('button', { name: 'Finish setup' })).toBeNull();
    expect(screen.getByText(/Only your backup private key can open them/)).toBeDefined();
  });
  it('sends a restored install to sign in, since the setup session is not in the restored database', async () => {
    sessionStorage.setItem('setup.restore', '019a0af0-9c00-7000-8000-0000000000aa');
    start(0);
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeDefined();
    expect(screen.getByRole('status').textContent).toContain('Backup restored.');
    expect(screen.getByRole('status').textContent).toContain('Billing, member emails and member texts remain off');
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(screen.queryByRole('link', { name: 'Open admin' })).toBeNull();
  });
  it('can finish at step 8 after a confirmed key survives a reload', async () => {
    const { fetcher } = start(8, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await screen.findByText('Import or start fresh')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open admin' }).getAttribute('href')).toBe('/admin');
    expect(screen.getByRole('heading', { name: 'Setup complete' })).toBeDefined();
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/finish');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'fresh', revision: 1 });
  });
  it('retains entered fields on a failed save', async () => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Retry Academy');
    await waitFor(() => expect(screen.getByLabelText('Gym name')).toBeDefined());
    fetcher.mockResolvedValueOnce(Response.json({}, { status: 500 }));
    fireEvent.submit(screen.getByRole('button', { name: 'Save and continue' }).closest('form')!);
    await screen.findByText('Could not save this step. Check the details and try again.');
    expect((screen.getByLabelText('Gym name') as HTMLInputElement).value).toBe('Retry Academy');
  });
  it('never treats a rejected setup request as successful', async () => {
    const client = createSetupClient(async () => Response.json({}, { status: 409 }));
    await expect(client.call('start', { choice: 'fresh' })).rejects.toBeInstanceOf(ApiError);
  });
});

/** Fills the email step and sends its test. */
async function sendTestEmail() {
  await userEvent.type(await screen.findByLabelText('SMTP hostname'), 'smtp.example.test');
  await userEvent.type(screen.getByLabelText('SMTP username'), 'sender');
  await userEvent.type(screen.getByLabelText('SMTP password'), 'private-smtp-password');
  await userEvent.type(screen.getByLabelText('Sender email address'), 'gym@example.test');
  await userEvent.type(screen.getByLabelText('Test recipient email address'), 'owner@example.test');
  await userEvent.click(screen.getByRole('button', { name: 'Send test email and save' }));
}
async function generateKey() {
  await userEvent.type(await screen.findByLabelText('S3-compatible endpoint URL'), 'https://s3.example.test');
  await userEvent.type(screen.getByLabelText('Storage bucket'), 'gym-backups');
  await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
  await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'private-storage-secret');
  await userEvent.click(screen.getByRole('button', { name: 'Generate backup key' }));
  await screen.findByText(privateKey);
}
const actionBar = () => within(screen.getByRole('group', { name: 'Setup actions' }));
describe('setup wizard confirmations', () => {
  it('stays on the email step after a sent test, says where it went, and continues on request', async () => {
    const { fetcher } = start(5);
    await sendTestEmail();
    expect((await screen.findByRole('status')).textContent).toBe('Test email sent to owner@example.test. Check your inbox (and spam folder), then continue.');
    expect(screen.getByRole('heading', { name: 'Email delivery' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Skip Google sign-in' })).toBeNull();
    await userEvent.click(actionBar().getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('button', { name: 'Skip Google sign-in' })).toBeDefined();
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/setup/smtp')).toHaveLength(1);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('private-smtp-password');
  });
  it.each([
    [{ failure: 'tls' }, "The test email failed: the secure connection didn't start, or the server didn't offer a secure connection on this port. Implicit TLS should be on for port 465 and off for ports 587 and 2525; if that is already right, use the port your service lists for secure sending. Or skip this step."],
    [{}, 'The test email failed. Check your SMTP settings and try again, or skip this step.'],
  ] as const)('keeps the failed email test on the form with the error for %o', async (failure, message) => {
    const { fetcher } = start(5);
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/smtp')
      ? Promise.resolve(Response.json({ data: { configured: false, test: 'failed', ...failure, revision: 1 } })) : answer(path, options));
    await sendTestEmail();
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(screen.getByRole('button', { name: 'Send test email and save' })).toBeDefined();
  });
  it('mentions the alternative SMTP port in the email hint', async () => {
    start(5);
    expect(await screen.findByText(/block outgoing email on ports 25, 465 and 587.*such as 2525/)).toBeDefined();
  });
  it.each([
    [2525, true, /Implicit TLS is on, but the port isn't 465/],
    [465, false, /Port 465 usually needs implicit TLS/],
    [587, false, null],
  ] as const)('shows advice for port %i with implicit TLS %s and still sends the test', async (port, secure, hint) => {
    const { fetcher } = start(5);
    const portInput = await screen.findByLabelText('SMTP port');
    const checkbox = screen.getByRole('checkbox', { name: /Use implicit TLS/ });
    await userEvent.clear(portInput);
    await userEvent.type(portInput, String(port));
    if (secure) await userEvent.click(checkbox);
    if (hint) expect(screen.getByText(hint).getAttribute('aria-live')).toBe('polite');
    else expect(screen.queryByText(/Implicit TLS is on|Port 465 usually needs implicit TLS/)).toBeNull();
    if (secure && hint) {
      await userEvent.click(checkbox);
      expect(screen.queryByText(hint)).toBeNull();
      await userEvent.click(checkbox);
    }
    await sendTestEmail();
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/smtp');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ port, secure });
    await screen.findByText(/Test email sent to/);
  });
  it('says when the Google client was saved unchecked', async () => {
    const { fetcher } = start(6);
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/google')
      ? Promise.resolve(Response.json({ data: { configured: true, check: 'unknown', revision: 2 } })) : answer(path, options));
    await userEvent.type(await screen.findByLabelText('Client ID'), 'client.apps.googleusercontent.com');
    await userEvent.type(screen.getByLabelText('Client secret'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save Google client' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/^Saved, but Google couldn't be asked to check this client/);
    expect(actionBar().getByRole('button', { name: 'Continue' })).toBeDefined();
  });
  it('refuses a client Google rejected with a field error, focused, and keeps the page', async () => {
    const { fetcher } = start(6);
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/google')
      ? Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'detail', details: { reason: ['google_rejected'] } } }, { status: 400 }))
      : answer(path, options));
    await userEvent.type(await screen.findByLabelText('Client ID'), 'client.apps.googleusercontent.com');
    await userEvent.type(screen.getByLabelText('Client secret'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save Google client' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Google didn't accept this client ID and secret/);
    expect(alert.dataset.variant).toBe('error');
    await waitFor(() => expect(document.activeElement).toBe(alert));
    for (const name of ['Client ID', 'Client secret']) {
      const input = screen.getByLabelText(name);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(document.getElementById(input.getAttribute('aria-describedby')!.split(' ').at(-1)!)?.textContent).toMatch(/doesn't recognise this client/);
    }
    expect(actionBar().getByText('See the message at the top of this step.')).toBeDefined();
    expect(screen.queryByLabelText('Restricted Stripe key')).toBeNull();
    await userEvent.type(screen.getByLabelText('Client ID'), 'x');
    for (const name of ['Client ID', 'Client secret']) expect(screen.getByLabelText(name).getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/doesn't recognise this client/)).toBeNull();
  });
  it('shows the backup key labelled, then confirms it and stays with a word that backups are on', async () => {
    start(7);
    await generateKey();
    expect(screen.getByRole('group', { name: 'Backup private key: keep it secret' }).textContent).toContain(privateKey);
    expect(screen.getByText(privateKey).className).toMatch(/break-all/);
    expect(screen.getByRole('group', { name: 'Public key: snapshots are encrypted to it; safe to share' }).textContent).toContain(publicKey);
    expect(screen.getByText(/If you close this page before confirming, this key is replaced/)).toBeDefined();
    const confirm = screen.getByRole('region', { name: 'Confirm you saved the key' });
    expect(within(confirm).getByText(/Paste the private key from where you stored it/)).toBeDefined();
    const field = within(confirm).getByLabelText('Paste your saved private key') as HTMLInputElement;
    expect(field.type).toBe('password');
    await userEvent.type(field, privateKey);
    await userEvent.click(within(confirm).getByRole('checkbox'));
    await userEvent.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
    expect((await screen.findByText(/^Backups are on: the destination passed its check\./)).getAttribute('role')).toBe('status');
    expect(screen.queryByText(privateKey)).toBeNull();
    await userEvent.click(actionBar().getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('Step 9 / 9')).toBeDefined();
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toMatch(/AGE-SECRET-KEY|private-storage-secret/);
  });
  it('says the pasted key doesn’t match, without sending a malformed one', async () => {
    const { fetcher } = start(7);
    await generateKey();
    const confirm = screen.getByRole('region', { name: 'Confirm you saved the key' });
    await userEvent.click(within(confirm).getByRole('checkbox'));
    for (const pasted of ['not a key', 'AGE-SECRET-KEY-1ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ']) {
      const field = within(confirm).getByLabelText('Paste your saved private key');
      await userEvent.clear(field); await userEvent.type(field, pasted);
      await userEvent.click(within(confirm).getByRole('button', { name: 'Check the saved key' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe("This key doesn't match the one shown. Paste the whole key, starting with AGE-SECRET-KEY-.");
      expect(alert.dataset.variant).toBe('error');
    }
    await waitFor(() => expect(fetcher.mock.calls.filter(([path]) => path === '/api/setup/backups/confirm')).toHaveLength(1));
    expect(screen.getByText(privateKey)).toBeDefined();
  });
  it('copies the private key, or selects it where the clipboard is refused', async () => {
    start(7);
    await generateKey();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await screen.findByText('Copied.');
    expect(writeText).toHaveBeenCalledWith(privateKey);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); }) }, configurable: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await screen.findByText(/The key is selected/);
    expect(window.getSelection()?.getRangeAt(0).toString()).toBe(privateKey);
  });
  it('focuses the error after a failed submit on a long step', async () => {
    const { fetcher } = start(7);
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/backups')
      ? Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'x', details: { destination: ['unreachable'] } } }, { status: 400 })) : answer(path, options));
    await userEvent.type(await screen.findByLabelText('S3-compatible endpoint URL'), 'https://s3.example.test');
    await userEvent.type(screen.getByLabelText('Storage bucket'), 'b');
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'a');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 's');
    await userEvent.click(screen.getByRole('button', { name: 'Generate backup key' }));
    const alert = await screen.findByRole('alert');
    expect(alert.dataset.variant).toBe('error');
    expect(alert.tabIndex).toBe(-1);
    await waitFor(() => expect(document.activeElement).toBe(alert));
  });
});

describe('setup wizard field checks', () => {
  const described = (input: HTMLElement) => (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  it('says nothing about an untouched field, checks it on leaving, then on every change', async () => {
    start(5);
    const from = await screen.findByLabelText('Sender email address');
    expect(from.getAttribute('aria-invalid')).toBeNull();
    expect(screen.queryByText('Looks right')).toBeNull();
    // The result's line is there, empty, before the field is visited, so a result never moves the buttons below it.
    expect(document.getElementById(from.id + '-check')?.textContent).toBe('');
    expect(described(from)).toMatch(/The From address, on a domain your sending service has verified/);
    await userEvent.type(from, 'gym@');
    expect(from.getAttribute('aria-invalid')).toBeNull();
    await userEvent.tab();
    expect(from.getAttribute('aria-invalid')).toBe('true');
    expect(described(from)).toContain('Enter an email address, such as name@example.com.');
    await userEvent.type(from, 'example.test');
    expect(from.getAttribute('aria-invalid')).toBeNull();
    expect(described(from)).toContain('Looks right');
    // An empty required field says so once visited.
    const host = screen.getByLabelText('SMTP hostname');
    expect(described(host)).toMatch(/Your sending service's SMTP server/);
    await userEvent.click(host); await userEvent.tab();
    expect(host.getAttribute('aria-invalid')).toBe('true');
    expect(described(host)).toContain('Fill in this field.');
    const port = screen.getByLabelText('SMTP port');
    await userEvent.clear(port); await userEvent.type(port, '70000'); await userEvent.tab();
    expect(described(port)).toContain('Enter a port number from 1 to 65535.');
  });
  it('checks the gym step against the shared schemas', async () => {
    start(2);
    const currency = await screen.findByLabelText('Billing currency (three letters)');
    await userEvent.clear(currency); await userEvent.type(currency, 'us'); await userEvent.tab();
    expect(described(currency)).toContain('Enter a three-letter currency code');
    await userEvent.type(currency, 'd');
    expect(described(currency)).toContain('Looks right');
    const zone = screen.getByLabelText('Timezone');
    await userEvent.clear(zone); await userEvent.type(zone, 'CET'); await userEvent.tab();
    expect(zone.getAttribute('aria-invalid')).toBe('true');
    expect(described(zone)).toContain('Enter an IANA timezone');
    // An optional field left blank shows nothing.
    const address = screen.getByLabelText('Street address');
    await userEvent.click(address); await userEvent.tab();
    expect(address.getAttribute('aria-invalid')).toBeNull();
    expect(described(address)).toBe('');
  });
  it('splits an R2 address that ends with the bucket name', async () => {
    start(7);
    const endpoint = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const bucket = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(bucket, 'gym-backups');
    await userEvent.type(endpoint, 'https://account.r2.cloudflarestorage.com/gym-backups'); await userEvent.tab();
    expect(endpoint.value).toBe('https://account.r2.cloudflarestorage.com');
    expect(bucket.value).toBe('gym-backups');
    expect(described(endpoint)).toContain('Using bucket gym-backups from this address.');
    expect(described(endpoint)).toContain('Looks right');
    await userEvent.clear(endpoint); await userEvent.type(endpoint, 'https://account.r2.cloudflarestorage.com');
    expect(described(endpoint)).toContain('Looks right');
    await userEvent.clear(endpoint); await userEvent.type(endpoint, 'not an address');
    expect(described(endpoint)).toContain('Enter a full address starting with https://.');
  });
});

describe('splitBucketAddress', () => {
  const described = (input: HTMLElement) => (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const r2 = 'https://account.r2.cloudflarestorage.com/o1test';
  it('splits R2 per-bucket S3 API addresses and decodes the bucket', () => {
    expect(splitBucketAddress(' https://account.r2.cloudflarestorage.com/o1test '))
      .toEqual({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'o1test' });
    expect(splitBucketAddress('https://acct.r2.cloudflarestorage.com/backups'))
      .toEqual({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'backups' });
    expect(splitBucketAddress('https://account.r2.cloudflarestorage.com/o1%20test'))
      .toEqual({ endpoint: 'https://account.r2.cloudflarestorage.com', bucket: 'o1 test' });
  });
  it.each(['not an address', 'http://account.r2.cloudflarestorage.com/o1test', 'https://account.r2.cloudflarestorage.com/o1test?x=1',
    'https://account.r2.cloudflarestorage.com/o1test#part', 'https://user:secret@account.r2.cloudflarestorage.com/o1test',
    'https://account.r2.cloudflarestorage.com/a/b', 'https://account.r2.cloudflarestorage.com/', 'https://account.r2.cloudflarestorage.com/%E0%A4%A',
    'https://storage.example.com/minio'])('returns null for %s',
  (address) => expect(splitBucketAddress(address)).toBeNull());
  it('limits endpointCheck bucket-path refusals to R2 hosts', () => {
    const formWithBucket = (bucket: string) => {
      const form = document.createElement('form'), input = document.createElement('input');
      input.name = 'bucket'; input.value = bucket; form.append(input);
      return form;
    };
    expect(fieldChecks.endpoint!('https://storage.example.com/minio', formWithBucket('backups'))).toBeNull();
    expect(fieldChecks.endpoint!('https://storage.example.com/minio', formWithBucket('minio'))).toBeNull();
    expect(fieldChecks.endpoint!('https://acct.r2.cloudflarestorage.com/backups', formWithBucket('other'))).toBe('check.bucketPath');
  });
  it('keeps the split note on a second blur and clears it when the bucket or endpoint changes', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const bucket = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, r2);
    await userEvent.tab();
    expect(described(url)).toContain('Using bucket o1test from this address.');
    url.focus();
    await userEvent.tab();
    expect(described(url)).toContain('Using bucket o1test from this address.');
    await userEvent.type(bucket, 'x');
    expect(described(url)).not.toContain('Using bucket o1test from this address.');
    cleanup();
    localStorage.clear();
    start(7);
    const secondUrl = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    await userEvent.type(secondUrl, r2);
    await userEvent.tab();
    expect(described(secondUrl)).toContain('Using bucket o1test from this address.');
    await userEvent.type(secondUrl, 'x');
    expect(described(secondUrl)).not.toContain('Using bucket o1test from this address.');
  });
  it('leaves a path-prefixed endpoint as typed and the bucket empty on blur', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const bucket = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, 'https://storage.example.com/minio');
    await userEvent.tab();
    expect(url.value).toBe('https://storage.example.com/minio');
    expect(bucket.value).toBe('');
    expect(described(url)).not.toContain('Using bucket');
    expect(described(url)).toContain('Looks right');
  });
  it('adds the recheck form input listener once across five rerenders of the storage step', async () => {
    const add = vi.spyOn(HTMLFormElement.prototype, 'addEventListener');
    try {
      const fetcher = vi.fn(async () => Response.json({ data: { currentStep: 7, completedSteps: [0, 1, 2, 3, 4, 5, 6], completed: false, revision: 1, googleSkipped: true, backupsLater: false } }));
      const client = createSetupClient(fetcher as typeof fetch);
      const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      const view = (registries = createRegistries()) => (
        <QueryClientProvider client={query}><ShellServicesContext.Provider value={services}><SetupWizard client={client} registries={registries} /></ShellServicesContext.Provider></QueryClientProvider>
      );
      const { rerender } = render(view());
      await screen.findByLabelText('S3-compatible endpoint URL');
      for (let i = 0; i < 5; i++) rerender(view());
      expect(add.mock.calls.filter(([type]) => type === 'input')).toHaveLength(1);
    } finally { add.mockRestore(); }
  });
});

describe('setup wizard storage fields', () => {
  const described = (input: HTMLElement) => (input.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const r2 = 'https://account.r2.cloudflarestorage.com/o1test';
  const storageLabels = ['S3-compatible endpoint URL', 'Storage region', 'Storage bucket', 'S3 access key ID', 'S3 secret access key (not the Cloudflare API token value)'];
  it('splits an R2 bucket address into the endpoint and the bucket', async () => {
    const { fetcher } = start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, r2);
    await userEvent.tab();
    expect(url.value).toBe('https://account.r2.cloudflarestorage.com');
    expect(name.value).toBe('o1test');
    expect(described(url)).toContain('Using bucket o1test from this address.');
    expect(described(url)).toContain('Looks right');
    expect(url.getAttribute('aria-invalid')).toBeNull();
    expect(name.getAttribute('aria-invalid')).toBeNull();
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'private-storage-secret');
    await userEvent.click(screen.getByRole('button', { name: 'Generate backup key' }));
    await screen.findByText(privateKey);
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/backups');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ revision: 1, destination: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto',
      bucket: 'o1test', accessKeyId: 'access', secretAccessKey: 'private-storage-secret' } });
  });
  it('splits when the bucket already holds the address’s last segment', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(name, 'o1test');
    await userEvent.type(url, r2);
    await userEvent.tab();
    expect(url.value).toBe('https://account.r2.cloudflarestorage.com');
    expect(name.value).toBe('o1test');
    expect(described(url)).toContain('Using bucket o1test from this address.');
    expect(described(url)).toContain('Looks right');
  });
  it('keeps a typed bucket and shows the mismatch until the endpoint is left again', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(name, 'other');
    await userEvent.type(url, r2);
    await userEvent.tab();
    expect(url.value).toBe(r2);
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(described(url)).toContain('Use the address without the bucket name.');
    expect(name.value).toBe('other');
    await userEvent.clear(name);
    await userEvent.type(name, 'o1test');
    expect(described(url)).toContain('Use the address without the bucket name.');
    expect(url.getAttribute('aria-invalid')).toBe('true');
    url.focus();
    await userEvent.tab();
    expect(url.value).toBe('https://account.r2.cloudflarestorage.com');
    expect(name.value).toBe('o1test');
    expect(described(url)).toContain('Using bucket o1test from this address.');
    expect(described(url)).toContain('Looks right');
    expect(url.getAttribute('aria-invalid')).toBeNull();
  });
  it('leaves a plain endpoint unchanged without a note', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, 'https://s3.example.test');
    await userEvent.tab();
    expect(url.value).toBe('https://s3.example.test');
    expect(name.value).toBe('');
    expect(described(url)).not.toContain('Using bucket');
    expect(described(url)).toContain('Looks right');
  });
  it('leaves a virtual-hosted endpoint unchanged without a note', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, 'https://o1test.account.r2.cloudflarestorage.com');
    await userEvent.tab();
    expect(url.value).toBe('https://o1test.account.r2.cloudflarestorage.com');
    expect(name.value).toBe('');
    expect(described(url)).not.toContain('Using bucket');
    expect(described(url)).toContain('Looks right');
  });
  it('does not split an address with more than one path segment', async () => {
    start(7);
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, 'https://account.r2.cloudflarestorage.com/a/b');
    await userEvent.tab();
    expect(url.value).toBe('https://account.r2.cloudflarestorage.com/a/b');
    expect(name.value).toBe('');
    expect(described(url)).not.toContain('Using bucket');
  });
  it('labels the key fields as S3 keys and never says they look right', async () => {
    start(7);
    const id = await screen.findByLabelText('S3 access key ID') as HTMLInputElement;
    const secret = screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)') as HTMLInputElement;
    await userEvent.type(id, 'access');
    await userEvent.tab();
    expect(described(id)).not.toContain('Looks right');
    expect(id.getAttribute('aria-invalid')).toBeNull();
    await userEvent.type(secret, 'secret');
    await userEvent.tab();
    expect(described(secret)).not.toContain('Looks right');
    expect(secret.getAttribute('aria-invalid')).toBeNull();
    await userEvent.clear(id);
    await userEvent.tab();
    expect(described(id)).toContain('Fill in this field.');
    await userEvent.clear(secret);
    await userEvent.tab();
    expect(described(secret)).toContain('Fill in this field.');
  });
  it('splits the R2 address in the restore form too', async () => {
    const { fetcher } = start();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    const url = await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement;
    const name = screen.getByLabelText('Storage bucket') as HTMLInputElement;
    await userEvent.type(url, r2);
    await userEvent.tab();
    expect(url.value).toBe('https://account.r2.cloudflarestorage.com');
    expect(name.value).toBe('o1test');
    expect(described(url)).toContain('Using bucket o1test from this address.');
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'private-storage-secret');
    await userEvent.type(screen.getByLabelText('Snapshot ID or snapshots/ID/ prefix'), 'snapshots/abc/');
    await userEvent.type(screen.getByLabelText('Backup private key'), 'AGE-SECRET-KEY-1EXAMPLE');
    await userEvent.click(screen.getByRole('button', { name: 'Restore a backup' }));
    const call = fetcher.mock.calls.find(([path]) => path === '/api/setup/restore');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ choice: 'restore', source: { endpoint: 'https://account.r2.cloudflarestorage.com', region: 'auto',
      bucket: 'o1test', accessKeyId: 'access', secretAccessKey: 'private-storage-secret' }, snapshotPrefix: 'snapshots/abc/', privateKey: 'AGE-SECRET-KEY-1EXAMPLE' });
  });
  it('keeps every storage input inside a form', async () => {
    start(7);
    await screen.findByLabelText('S3-compatible endpoint URL');
    const backupForms = storageLabels.map((label) => (screen.getByLabelText(label) as HTMLInputElement).form);
    expect(backupForms.every(Boolean)).toBe(true);
    expect(new Set(backupForms).size).toBe(1);
    cleanup();
    start();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    await screen.findByLabelText('S3-compatible endpoint URL');
    const restoreForms = storageLabels.map((label) => (screen.getByLabelText(label) as HTMLInputElement).form);
    expect(restoreForms.every(Boolean)).toBe(true);
    expect(new Set(restoreForms).size).toBe(1);
  });
});

describe('setup wizard resume', () => {
  it('keeps a draft of the open step’s non-secret fields and clears it when the step saves', async () => {
    start(5);
    await userEvent.type(await screen.findByLabelText('SMTP hostname'), 'smtp.example.test');
    await userEvent.type(screen.getByLabelText('SMTP username'), 'token-user');
    await userEvent.type(screen.getByLabelText('SMTP password'), 'private-smtp-password');
    await userEvent.type(screen.getByLabelText('Sender email address'), 'gym@example.test');
    expect(JSON.parse(localStorage.getItem('setup.draft.gym.5')!)).toEqual({ host: 'smtp.example.test', port: '587', from: 'gym@example.test' });
    cleanup();
    start(5);
    expect((await screen.findByLabelText('SMTP hostname') as HTMLInputElement).value).toBe('smtp.example.test');
    expect((screen.getByLabelText('Sender email address') as HTMLInputElement).value).toBe('gym@example.test');
    expect((screen.getByLabelText('SMTP username') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('SMTP password') as HTMLInputElement).value).toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Skip email configuration' }));
    await screen.findByRole('button', { name: 'Skip Google sign-in' });
    expect(localStorage.getItem('setup.draft.gym.5')).toBeNull();
    cleanup();
    start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Draft Academy');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await screen.findByText('Step 4 / 9');
    expect(localStorage.getItem('setup.draft.gym.2')).toBeNull();
  });
  it('asks for a site address only for a website of the gym\'s own', async () => {
    start(4);
    const address = await screen.findByLabelText('Existing website URL');
    expect(address.closest('[hidden]')).not.toBeNull();
    await userEvent.click(screen.getByLabelText('I already have a website'));
    expect(address.closest('[hidden]')).toBeNull();
    await userEvent.click(screen.getByLabelText('Use the built-in website'));
    expect(address.closest('[hidden]')).not.toBeNull();
  });
  it('doesn\'t let a hidden address the browser would reject block the built-in website', async () => {
    start(4);
    await userEvent.click(await screen.findByLabelText('I already have a website'));
    const address = screen.getByLabelText('Existing website URL') as HTMLInputElement;
    await userEvent.type(address, 'mygym');
    expect(address.form!.checkValidity()).toBe(false);
    await userEvent.click(screen.getByLabelText('Use the built-in website'));
    expect(address.closest('fieldset[disabled]')).not.toBeNull();
    expect(address.form!.checkValidity()).toBe(true);
  });
  it('reopens a website draft with an address on "I already have a website"', async () => {
    start(4);
    await userEvent.click(await screen.findByLabelText('I already have a website'));
    await userEvent.type(screen.getByLabelText('Existing website URL'), 'https://gym.example.test');
    cleanup();
    start(4);
    expect((await screen.findByLabelText('Existing website URL') as HTMLInputElement).value).toBe('https://gym.example.test');
    expect((screen.getByLabelText('I already have a website') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Use the built-in website') as HTMLInputElement).checked).toBe(false);
  });
  it('keeps the backup destination, never its secret or key, until the key is confirmed', async () => {
    start(7);
    await generateKey();
    expect(JSON.parse(localStorage.getItem('setup.draft.gym.7')!)).toEqual({ endpoint: 'https://s3.example.test', region: 'auto', bucket: 'gym-backups' });
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toMatch(/private-storage-secret|access"|AGE-SECRET-KEY|age1/);
    cleanup();
    // Reopened before confirming: the destination comes back, and a new key is made for it.
    start(7);
    expect((await screen.findByLabelText('S3-compatible endpoint URL') as HTMLInputElement).value).toBe('https://s3.example.test');
    expect((screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)') as HTMLInputElement).value).toBe('');
  });
  it('resumes past backups set up later, at step 9 with a way back', async () => {
    const { fetcher } = start(7, [0, 1, 2, 3, 4, 5, 6], undefined, { backupsLater: true });
    expect(await screen.findByText('Step 9 / 9')).toBeDefined();
    await userEvent.click(await screen.findByRole('button', { name: 'Back to backups' }));
    expect(await screen.findByRole('button', { name: 'Generate backup key' })).toBeDefined();
    const decision = fetcher.mock.calls.find(([path]) => path === '/api/setup/decisions');
    expect(JSON.parse(String(decision?.[1]?.body))).toEqual({ revision: 1, decision: 'backups_now' });
  });
});

describe('setup wizard restore progress', () => {
  const running = (phase: string) => () => Response.json({ data: { status: 'running', jobId: restoreJob, phase } });
  const failed = (reason: string, staged: boolean) => () => Response.json({ data: { status: 'failed', jobId: restoreJob, message: 'Restore failed.', reason, staged } });
  const restoring = /Restoring your verified backup/;
  async function startRestore() {
    const started = start(0);
    await fillRestore();
    await sendRestore();
    return started;
  }
  const sendRestore = () => userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Restore a backup' }));
  async function fillRestore() {
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    await userEvent.type(screen.getByLabelText('S3-compatible endpoint URL'), 'https://s3.example.test');
    await userEvent.type(screen.getByLabelText('Storage bucket'), 'backups');
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'secret');
    await userEvent.type(screen.getByLabelText('Snapshot ID or snapshots/ID/ prefix'), '019a0af0-9c00-7000-8000-0000000000cc');
    await userEvent.click(screen.getByLabelText('Backup private key')); await userEvent.paste(privateKey);
  }
  /** Runs the next restore poll: one second while the server answers, five while it doesn't. */
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('names the cause of a failed restore, without the maintenance command when nothing is staged', async () => {
    restorePolls = [failed('credentials_rejected', false)];
    await startRestore();
    expect(await screen.findByText('Restore failed: the storage service rejected the access key ID or secret. Check both, then start again.')).toBeDefined();
    expect(document.body.textContent).not.toMatch(/maintenance/i);
    expect(screen.queryByText(restoring)).toBeNull();
    // Starting fresh instead leaves the failure behind on step 0.
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByRole('heading', { name: 'Create your owner account' })).toBeDefined();
    expect(screen.queryByText(/^Restore failed/)).toBeNull();
  });
  it('names a refused access apart from rejected keys', async () => {
    restorePolls = [failed('access_denied', false)];
    await startRestore();
    expect(await screen.findByText("Restore failed: the storage service refused access. Check the key's permissions on this bucket, and the snapshot ID, then start again.")).toBeDefined();
    expect(document.body.textContent).not.toMatch(/rejected the access key/);
  });
  it('says a verified restore is staged, and how it finishes, when the server says so', async () => {
    restorePolls = [failed('other', true)];
    await startRestore();
    expect(await screen.findByText(/^Restore failed\. Check the storage details, snapshot ID and private key, then start again\. The server log has the cause\.$/)).toBeDefined();
    expect(screen.getByText(/^A verified restore is staged on the server\./).textContent).toContain('maintenance command');
  });
  it('shows a server that stops answering instead of the spinner, and keeps checking', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [running('verifying'), () => { throw new TypeError('Failed to fetch'); }, running('database'), () => new Response('Bad gateway', { status: 502 })];
    const { fetcher } = start(0);
    expect(await screen.findByText(restoring)).toBeDefined();
    await tick(1000);
    expect(await screen.findByText("The server isn't answering. This page keeps checking.")).toBeDefined();
    expect(screen.getByText(/^If the server restarted while the backup was being checked/)).toBeDefined();
    expect(screen.queryByText(restoring)).toBeNull();
    // While unreachable, it checks every five seconds.
    const polls = () => fetcher.mock.calls.filter(([path]) => String(path).startsWith('/api/setup/restore/')).length;
    await tick(4000);
    expect(polls()).toBe(2);
    await tick(1000);
    expect(await screen.findByText(restoring)).toBeDefined();
    expect(polls()).toBe(3);
    await tick(1000);
    expect(await screen.findByText('The backup was verified, so the restore carries on by itself when the server is back.')).toBeDefined();
    expect(screen.queryByText(restoring)).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBe(restoreJob);
  });
  it('keeps checking after a server error, without guessing the phase it never saw', async () => {
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [() => Response.json({ error: { code: 'internal', message: 'Internal error' } }, { status: 500 })];
    start(0);
    expect(await screen.findByText("The server isn't answering. This page keeps checking.")).toBeDefined();
    expect(screen.queryByText(/^If the server restarted while the backup was being checked/)).toBeNull();
    expect(screen.queryByText(/^The backup was verified/)).toBeNull();
    expect(screen.queryByText('Could not read restore progress. Reload this page to retry.')).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBe(restoreJob);
  });
  it('stops polling and shows the progress error on step 0 when the server no longer knows the restore', async () => {
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [() => Response.json({ error: { code: 'not_found', message: 'Restore not found' } }, { status: 404 })];
    start(0);
    expect(await screen.findByText('Could not read restore progress. Reload this page to retry.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Start fresh or restore a backup' })).toBeDefined();
    expect(screen.queryByText(restoring)).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBeNull();
  });
  it('keeps polling at the slower interval when restore status returns 429', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [
      () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429 }),
      running('database'),
    ];
    const { fetcher } = start(0);
    expect(await screen.findByText(restoring)).toBeDefined();
    expect(screen.queryByText('Could not read restore progress. Reload this page to retry.')).toBeNull();
    expect(screen.queryByText("The server isn't answering. This page keeps checking.")).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBe(restoreJob);
    const polls = () => fetcher.mock.calls.filter(([path]) => String(path).startsWith('/api/setup/restore/')).length;
    await tick(4000);
    expect(polls()).toBe(1);
    await tick(1000);
    expect(polls()).toBe(2);
    expect(await screen.findByText(restoring)).toBeDefined();
    expect(screen.queryByText("The server isn't answering. This page keeps checking.")).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBe(restoreJob);
  });
  it('keeps saying the server is not answering when a rate-limited poll follows', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [
      () => { throw new TypeError('Failed to fetch'); },
      () => Response.json({ error: { code: 'rate_limited', message: 'Too many requests' } }, { status: 429 }),
    ];
    const { fetcher } = start(0);
    expect(await screen.findByText("The server isn't answering. This page keeps checking.")).toBeDefined();
    await tick(5000);
    expect(fetcher.mock.calls.filter(([path]) => String(path).startsWith('/api/setup/restore/')).length).toBe(2);
    expect(screen.getByText("The server isn't answering. This page keeps checking.")).toBeDefined();
    expect(screen.queryByText(restoring)).toBeNull();
    expect(sessionStorage.getItem('setup.restore')).toBe(restoreJob);
  });
  it('shows the email-unavailable message when sending the owner sign-in link fails with 503 EMAIL_UNAVAILABLE', async () => {
    const emailUnavailable = "The gym's email isn't working right now, so no sign-in link was sent. Check the server's email (SMTP) settings, then try again.";
    const genericFailed = 'Could not save this step. Check the details and try again.';
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(2);
    const base = fetcher.getMockImplementation()!;
    const sentText = 'Check your inbox for a sign-in link, then return here to continue setup.';
    const responses = [
      Response.json({ status: true }),
      Response.json({ code: 'EMAIL_UNAVAILABLE', message: 'x' }, { status: 503 }),
      Response.json({ code: 'OTHER_ERROR', message: 'x' }, { status: 503 }),
      Response.json({ error: { code: 'internal' } }, { status: 500 }),
    ];
    fetcher.mockImplementation((path, options) => String(path) === '/api/auth/sign-in/magic-link'
      ? Promise.resolve(responses.shift()!)
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Email address'), 'owner@example.org');
    const signInButton = screen.getByRole('button', { name: 'Sign in' });

    await userEvent.click(signInButton);
    expect(await screen.findByText(sentText)).toBeDefined();

    // A resend that fails because the email is down drops the earlier "check your inbox" note.
    await userEvent.click(signInButton);
    expect(await screen.findByText(emailUnavailable)).toBeDefined();
    expect(screen.queryByText(sentText)).toBeNull();

    await userEvent.click(signInButton);
    const otherServiceFailure = await screen.findByText(genericFailed);

    // The 500's alert replaces the previous one (the error clears when the request starts).
    await userEvent.click(signInButton);
    await waitFor(() => expect(screen.getByText(genericFailed)).not.toBe(otherServiceFailure));
    expect(responses).toHaveLength(0);
    expect(screen.queryByText(emailUnavailable)).toBeNull();
  });
  it('moves to the sign-in step at step 1 when owner creation succeeds and magic link returns 503 EMAIL_UNAVAILABLE, and retries only the link', async () => {
    const emailUnavailable = "The gym's email isn't working right now, so no sign-in link was sent. Check the server's email (SMTP) settings, then try again.";
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(1);
    const base = fetcher.getMockImplementation()!;
    const linkResponses = [
      () => Promise.resolve(Response.json({ code: 'EMAIL_UNAVAILABLE', message: 'x' }, { status: 503 })),
      () => Promise.resolve(Response.json({ status: true })),
    ];
    fetcher.mockImplementation((path, options) => String(path) === '/api/auth/sign-in/magic-link'
      ? linkResponses.shift()!()
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(emailUnavailable)).toBeDefined();
    expect(await screen.findByText('Sign in as the owner to continue setup.')).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    const countByPath = (target: string) => fetcher.mock.calls.filter(([path]) => String(path) === target).length;
    expect(countByPath('/api/setup')).toBe(2);
    expect(countByPath('/api/setup/owner')).toBe(1);
    expect(countByPath('/api/auth/sign-in/magic-link')).toBe(1);

    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Check your inbox for a sign-in link, then return here to continue setup.')).toBeDefined();
    expect(countByPath('/api/setup/owner')).toBe(1);
    expect(countByPath('/api/auth/sign-in/magic-link')).toBe(2);
  });
  it('moves to the sign-in step at step 1 when the magic link fails with a network error and retries only the link', async () => {
    const ownerSavedSignInFailed = "Your owner account was saved, but signing in didn't finish. Sign in as the owner to continue setup.";
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(1);
    const base = fetcher.getMockImplementation()!;
    const linkResponses = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(Response.json({ status: true })),
    ];
    fetcher.mockImplementation((path, options) => String(path) === '/api/auth/sign-in/magic-link'
      ? linkResponses.shift()!()
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(ownerSavedSignInFailed)).toBeDefined();
    expect(screen.queryByText('Could not save this step. Check the details and try again.')).toBeNull();
    expect(await screen.findByText('Sign in as the owner to continue setup.')).toBeDefined();
    const countByPath = (target: string) => fetcher.mock.calls.filter(([path]) => String(path) === target).length;
    expect(countByPath('/api/setup/owner')).toBe(1);

    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Check your inbox for a sign-in link, then return here to continue setup.')).toBeDefined();
    expect(countByPath('/api/setup/owner')).toBe(1);
    expect(countByPath('/api/auth/sign-in/magic-link')).toBe(2);
  });
  it('moves to the sign-in step at step 1 and says the owner was saved when password sign-in throws or rejects with 403', async () => {
    const ownerSavedSignInFailed = "Your owner account was saved, but signing in didn't finish. Sign in as the owner to continue setup.";
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: true, magicLink: false },
    });
    vi.mocked(services.signInWithPassword).mockRejectedValueOnce(new Error('sign-in failed'));
    const { fetcher } = start(1);

    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(ownerSavedSignInFailed)).toBeDefined();
    expect(screen.queryByText('Could not save this step. Check the details and try again.')).toBeNull();
    expect(await screen.findByText('Sign in as the owner to continue setup.')).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length).toBe(2);

    cleanup();
    vi.mocked(services.signInWithPassword).mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText(ownerSavedSignInFailed)).toBeDefined();
    expect(screen.queryByText(/Open the private setup link/)).toBeNull();
  });
  it('shows the rate-limited message at step 1 when owner creation succeeds and magic link returns 429', async () => {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(1);
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path) === '/api/auth/sign-in/magic-link'
      ? Promise.resolve(Response.json({ code: 'rate_limited', message: 'Too many requests' }, { status: 429 }))
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText('Too many attempts. Please wait before trying again.')).toBeDefined();
    expect(await screen.findByText('Sign in as the owner to continue setup.')).toBeDefined();
  });
  const unavailableText = 'Setup is unavailable for this install. Sign in to manage your gym.';
  const reloadText = 'Could not load the latest setup progress. Check your connection and try again.';
  const changedText = 'Setup changed in another window. Your progress has been refreshed.';
  const gone = () => Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 });
  const serverError = () => Response.json({}, { status: 500 });
  const statusReads = (fetcher: ReturnType<typeof start>['fetcher']) => fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length;
  /** Saves the gym step against a newer revision, with the reload that follows answering `reload` (the usual status when null). */
  async function saveGymAnswering409(reload: (() => Response) | null) {
    const started = start(2);
    const base = started.fetcher.getMockImplementation()!;
    started.fetcher.mockImplementation((path, options) => String(path).endsWith('/gym')
      ? Promise.resolve(Response.json({ error: { code: 'conflict', message: 'Changed' } }, { status: 409 }))
      : base(path, options));
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Reload Academy');
    statusAnswer = reload;
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
    return started;
  }
  /** Saves the owner after "Start fresh" (so the cached status still says step 0) while every later status reload fails. */
  async function saveOwnerWithoutReload(linkFails: boolean) {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(0);
    const base = fetcher.getMockImplementation()!;
    let failStatus = false;
    fetcher.mockImplementation((path, options) => {
      if (String(path) === '/api/setup' && failStatus) return Promise.reject(new TypeError('Failed to fetch'));
      if (String(path) === '/api/auth/sign-in/magic-link') {
        return linkFails ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(Response.json({ status: true }));
      }
      return base(path, options);
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    failStatus = true;
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
    return fetcher;
  }
  function expectSignInStepOnly(fetcher: ReturnType<typeof start>['fetcher']) {
    expect(screen.getByRole('heading', { name: 'Gym details' })).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    expect(screen.queryByLabelText(/Password/)).toBeNull();
    expect(screen.queryByText('Setup is unavailable for this install. Sign in to manage your gym.')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup/owner').length).toBe(1);
  }
  it('shows the sign-in step and alert when status reload fails after earlier status data, and the reload alert with no status data', async () => {
    const fetcher = await saveOwnerWithoutReload(true);

    expect(await screen.findByText("Your owner account was saved, but signing in didn't finish. Sign in as the owner to continue setup.")).toBeDefined();
    expect(await screen.findByText('Sign in as the owner to continue setup.')).toBeDefined();
    expectSignInStepOnly(fetcher);

    cleanup();
    const failClient = createSetupClient(vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch);
    const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={query}><ShellServicesContext.Provider value={services}><SetupWizard client={failClient} /></ShellServicesContext.Provider></QueryClientProvider>);
    expect(await screen.findByText('Could not load the latest setup progress. Check your connection and try again.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.queryByText('Setup is unavailable for this install. Sign in to manage your gym.')).toBeNull();
  });
  it('does not bring the owner form back when the link is sent but the status reload fails', async () => {
    const fetcher = await saveOwnerWithoutReload(false);

    expect(await screen.findByText('Check your inbox for a sign-in link, then return here to continue setup.')).toBeDefined();
    expectSignInStepOnly(fetcher);
  });
  it('shows the reload alert on the step after the owner when the reload answers 500, and Try again reads the status again', async () => {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false },
      login: { password: true, magicLink: false },
    });
    const { fetcher } = start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    statusAnswer = serverError;
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reloadText);
    expect(screen.getByRole('heading', { name: 'Gym details' })).toBeDefined();
    expect(screen.getByText('Step 3 / 9')).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(alert));

    // Once a read works, its answer decides the step again, even one further on than the owner step left it.
    statusAnswer = () => Response.json({ data: { currentStep: 4, completedSteps: [0, 1, 2, 3], completed: false, revision: 3, googleSkipped: false, backupsLater: false } });
    const before = statusReads(fetcher);
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Your website' })).toBeDefined();
    expect(screen.queryByText(reloadText)).toBeNull();
    expect(statusReads(fetcher)).toBe(before + 1);
  });
  it('shows only the reload alert when the reload after a 409 fails', async () => {
    const { fetcher } = await saveGymAnswering409(serverError);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reloadText);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(screen.queryByText(changedText)).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(statusReads(fetcher)).toBe(2);
  });
  it('says the setup changed when the reload after a 409 works', async () => {
    await saveGymAnswering409(null);

    expect(await screen.findByText(changedText)).toBeDefined();
    expect(screen.queryByText(reloadText)).toBeNull();
  });
  it('focuses the reload alert after each failed reload a save asked for, including one already on screen', async () => {
    const { query } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Reload Academy');
    statusAnswer = serverError;
    const save = within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' });
    await userEvent.click(save);
    const alert = await screen.findByRole('alert');
    await waitFor(() => expect(document.activeElement).toBe(alert));

    save.focus();
    await userEvent.click(save);
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(query.getQueryState(['setup', 'status'])?.status).toBe('error');
  });
  it.each([
    ['before any save', false],
    ['after a save whose reload worked', true],
  ])('shows the reload alert for a failed background refetch %s without moving focus', async (_, saveFirst) => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Reload Academy');
    if (saveFirst) {
      await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
      await screen.findByRole('heading', { name: 'What do you teach?' });
    }
    const focused = document.activeElement;
    const before = statusReads(fetcher);
    statusAnswer = serverError;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(reloadText);
    expect(statusReads(fetcher)).toBe(before + 1);
    expect(document.activeElement).toBe(focused);
  });
  it('leaves focus off a reload alert already on screen while a save reads the status again', async () => {
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Reload Academy');
    statusAnswer = serverError;
    await act(async () => { window.dispatchEvent(new Event('visibilitychange')); });
    const alert = await screen.findByRole('alert');
    const base = fetcher.getMockImplementation()!;
    let answer = () => {};
    const held = new Promise<void>((resolve) => { answer = resolve; });
    fetcher.mockImplementation(async (path, options) => {
      if (String(path) === '/api/setup') await held;
      return base(path, options);
    });
    statusAnswer = null;
    const before = statusReads(fetcher);
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(statusReads(fetcher)).toBe(before + 1));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    expect(within(alert).getByRole('button', { name: 'Try again' })).toHaveProperty('disabled', true);
    expect(document.activeElement).not.toBe(alert);
    await act(async () => { answer(); });
    const next = await screen.findByRole('heading', { name: 'What do you teach?' });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(screen.queryByText(reloadText)).toBeNull();
  });
  it('keeps the owner form while signing in when the status had already failed to reload', async () => {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: true, magicLink: false },
    });
    let signedIn = () => {};
    vi.mocked(services.signInWithPassword).mockImplementationOnce(() => new Promise<void>((resolve) => { signedIn = resolve; }));
    start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    statusAnswer = serverError;
    await act(async () => { window.dispatchEvent(new Event('visibilitychange')); });
    await screen.findByRole('alert');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(services.signInWithPassword).toHaveBeenCalledTimes(1));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(screen.getByText('Step 2 / 9')).toBeDefined();
    await act(async () => { signedIn(); });
    expect(await screen.findByText('Step 3 / 9')).toBeDefined();
    expect(screen.queryByLabelText('Your name')).toBeNull();
  });
  it('focuses the new reload alert when Try again after a failed first read fails too', async () => {
    statusAnswer = serverError;
    const { fetcher } = start(0);
    await screen.findByText(reloadText);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(statusReads(fetcher)).toBe(2));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });
  it('offers Try again, not the unavailable screen, when the first status read answers 502', async () => {
    statusAnswer = () => Response.json({}, { status: 502 });
    start(0);

    expect(await screen.findByText(reloadText)).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    expect(screen.queryByText(/\/ 9$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Start fresh or restore a backup' })).toBeDefined();
    expect(screen.getByText('Step 1 / 9')).toBeDefined();
    expect(screen.queryByText(reloadText)).toBeNull();
  });
  it('offers Try again beside Sign in when the first status read answers 404, and shows the step a later answer names', async () => {
    statusAnswer = gone;
    start(4);

    expect(await screen.findByText(unavailableText)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByText(reloadText)).toBeNull();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Your website' })).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
  });
  it('shows an error with Try again when the session read fails at step 2, then loads the magic-link sign-in form on retry', async () => {
    vi.mocked(services.loadBootstrap)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: null,
        login: { password: false, magicLink: true },
      });
    start(2);

    expect(await screen.findByText('Could not check who is signed in. Check your connection, then try again.')).toBeDefined();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toBeDefined();
    expect(screen.queryByLabelText(/Password/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

    await userEvent.click(retry);
    expect(await screen.findByLabelText('Email address')).toBeDefined();
    expect(screen.queryByLabelText(/Password/)).toBeNull();
    expect(services.loadBootstrap).toHaveBeenCalledTimes(2);
  });
  it('shows the rate-limited message at the sign-in step on 429 and clears it on a following 200', async () => {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: false, magicLink: true },
    });
    const { fetcher } = start(2);
    const base = fetcher.getMockImplementation()!;
    const responses = [
      Response.json({ code: 'rate_limited', message: 'Too many requests' }, { status: 429 }),
      Response.json({ status: true }),
    ];
    fetcher.mockImplementation((path, options) => String(path) === '/api/auth/sign-in/magic-link'
      ? Promise.resolve(responses.shift()!)
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Email address'), 'owner@example.org');
    const signInButton = screen.getByRole('button', { name: 'Sign in' });

    await userEvent.click(signInButton);
    expect(await screen.findByText('Too many attempts. Please wait before trying again.')).toBeDefined();
    expect(screen.queryByText('Could not save this step. Check the details and try again.')).toBeNull();

    await userEvent.click(signInButton);
    expect(await screen.findByText('Check your inbox for a sign-in link, then return here to continue setup.')).toBeDefined();
    expect(screen.queryByText('Too many attempts. Please wait before trying again.')).toBeNull();
  });
  it('stays on the owner form with no extra status refetch when the owner POST returns 400', async () => {
    const { fetcher } = start(1);
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path) === '/api/setup/owner'
      ? Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'Bad request' } }, { status: 400 }))
      : base(path, options));

    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText('Could not save this step. Check the details and try again.')).toBeDefined();
    expect(screen.getByLabelText('Your name')).toBeDefined();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length).toBe(1);
  });
  it('keeps the gym step with a retry alert when status reload fails with a network error, then advances on retry', async () => {
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false },
      login: { password: true, magicLink: false },
    });
    const { fetcher } = start(2);
    await userEvent.type(await screen.findByLabelText('Gym name'), 'Reload Academy');
    const base = fetcher.getMockImplementation()!;
    let failReload = true;
    fetcher.mockImplementation((path, options) => {
      if (String(path) === '/api/setup' && failReload) {
        failReload = false;
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return base(path, options);
    });

    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByText('Could not load the latest setup progress. Check your connection and try again.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Gym details' })).toBeDefined();
    expect(screen.getByLabelText('Gym name')).toBeDefined();
    const statusCallsBeforeRetry = fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length;

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { name: 'What do you teach?' })).toBeDefined();
    expect(screen.queryByText('Could not load the latest setup progress. Check your connection and try again.')).toBeNull();
    expect(fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length).toBe(statusCallsBeforeRetry + 1);
  });
  it('shows unavailable with the sign-in link when a status reload answers 404 after earlier data', async () => {
    const { fetcher, query } = start(4);
    await screen.findByRole('heading', { name: 'Your website' });
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path) === '/api/setup'
      ? Promise.resolve(Response.json({ error: { code: 'not_found', message: 'Not found' } }, { status: 404 }))
      : base(path, options));

    await act(async () => { await query.refetchQueries({ queryKey: ['setup', 'status'] }); });

    expect(await screen.findByText('Setup is unavailable for this install. Sign in to manage your gym.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Your website' })).toBeNull();
    expect(screen.queryByText('Could not load the latest setup progress. Check your connection and try again.')).toBeNull();
  });
  const rejectedText = 'Restore failed: the storage service rejected the access key ID or secret. Check both, then start again.';
  /** Reloads the status and lets the screen take the answer, so a check that nothing changed means something. */
  const reloadStatus = (query: QueryClient) => act(async () => {
    await query.refetchQueries({ queryKey: ['setup', 'status'] });
    // The query tells React on a later task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  function expectCompletion() {
    expect(screen.getByRole('heading', { name: 'Setup complete' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open admin' })).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    expect(screen.queryByText(reloadText)).toBeNull();
  }
  it('keeps the completion screen from the registered import step when a later status reload answers 404', async () => {
    const { query } = start(8);
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeDefined();

    statusAnswer = gone;
    await reloadStatus(query);

    expect(query.getQueryState(['setup', 'status'])?.status).toBe('error');
    expectCompletion();
  });
  it.each([
    ['the registered import step', undefined, 'Start fresh'],
    ['the plain finish button', createWebRegistries<ExtensionView>([]), 'Finish setup'],
  ])('keeps %s through a 404 status reload while finishing, then shows the completion screen', async (_, registries, finish) => {
    const { fetcher, query } = start(8, [0, 1, 2, 3, 4, 5, 6], registries, { backupsLater: true });
    const base = fetcher.getMockImplementation()!;
    let answerFinish!: () => void;
    const held = new Promise<void>((resolve) => { answerFinish = resolve; });
    fetcher.mockImplementation(async (path, options) => {
      if (String(path).endsWith('/finish')) await held;
      return base(path, options);
    });
    await userEvent.click(await screen.findByRole('button', { name: finish }));
    await waitFor(() => expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/finish'))).toBe(true));
    // Leaving the step now would lose its completion screen.
    expect(screen.getByRole('button', { name: 'Back to backups' }).hasAttribute('disabled')).toBe(true);

    statusAnswer = gone;
    await reloadStatus(query);

    expect(screen.getByRole('button', { name: finish })).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    expect(screen.queryByText(reloadText)).toBeNull();
    await act(async () => { answerFinish(); });
    expect(await screen.findByRole('heading', { name: 'Setup complete' })).toBeDefined();
    expectCompletion();
  });
  it('shows unavailable on a 404 status reload after the import step failed to finish', async () => {
    const { fetcher, query } = start(8);
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/finish')
      ? Promise.resolve(Response.json({}, { status: 500 })) : base(path, options));
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByRole('alert')).toBeDefined();

    statusAnswer = gone;
    await reloadStatus(query);

    expect(screen.getByText(unavailableText)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Start fresh' })).toBeNull();
  });
  it('shows unavailable with the sign-in link on a 404 status reload after a failed restore, Back, and Start fresh', async () => {
    restorePolls = [failed('credentials_rejected', false)];
    const { query } = await startRestore();
    expect(await screen.findByText(rejectedText)).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByRole('heading', { name: 'Create your owner account' })).toBeDefined();

    statusAnswer = gone;
    await reloadStatus(query);

    expect(screen.getByText(unavailableText)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Sign in' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Create your owner account' })).toBeNull();
    expect(screen.queryByText(reloadText)).toBeNull();
  });
  it('keeps the staged restore message on step 0 when a status reload answers 404', async () => {
    restorePolls = [failed('other', true)];
    const { query } = await startRestore();
    expect(await screen.findByText(/^A verified restore is staged on the server\./)).toBeDefined();

    statusAnswer = gone;
    await reloadStatus(query);

    expect(query.getQueryState(['setup', 'status'])?.status).toBe('error');
    expect(screen.getByText(/^A verified restore is staged on the server\./)).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    expect(screen.queryByText(reloadText)).toBeNull();
  });
  it('does not reload the status on focus or reconnect while a restore runs, so its failure stays on screen', async () => {
    // The first poll runs at once; the second, a second later, brings the failure.
    restorePolls = [running('verifying'), failed('credentials_rejected', false)];
    const { fetcher } = await startRestore();
    expect(await screen.findByText(restoring)).toBeDefined();
    const reads = () => fetcher.mock.calls.filter(([path]) => String(path) === '/api/setup').length;
    const before = reads();

    statusAnswer = gone;
    await act(async () => {
      for (const event of ['visibilitychange', 'offline', 'online']) window.dispatchEvent(new Event(event));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads()).toBe(before);

    expect(await screen.findByText(rejectedText, undefined, { timeout: 3000 })).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    // With the restore over, a focus reloads the status again.
    statusAnswer = null;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(reads()).toBe(before + 1);
  });
  it('keeps the failure of a restore on screen after a reload whose first status answer was 404', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    sessionStorage.setItem('setup.restore', restoreJob);
    restorePolls = [running('verifying'), failed('credentials_rejected', false)];
    statusAnswer = gone;
    const { query } = start(0);
    expect(await screen.findByText(restoring)).toBeDefined();
    await waitFor(() => expect(query.getQueryState(['setup', 'status'])?.status).toBe('error'));

    // The failed restore released the gym, so the status answers again.
    statusAnswer = null;
    await tick(1000);

    expect(await screen.findByText(rejectedText)).toBeDefined();
    await waitFor(() => expect(query.getQueryState(['setup', 'status'])?.status).toBe('success'));
    await userEvent.click(screen.getByRole('button', { name: 'Restore a backup' }));
    expect(screen.getByLabelText('S3-compatible endpoint URL')).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
  });
  it('reads the status again when a restore fails after a 404 answered while the restore request was pending', async () => {
    restorePolls = [failed('credentials_rejected', false)];
    let answerRestore!: () => void;
    const held = new Promise<void>((resolve) => { answerRestore = resolve; });
    const { fetcher, query } = start(0);
    const base = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (path, options) => {
      if (String(path) === '/api/setup/restore') await held;
      return base(path, options);
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Restore a backup' }));
    await userEvent.type(screen.getByLabelText('S3-compatible endpoint URL'), 'https://s3.example.test');
    await userEvent.type(screen.getByLabelText('Storage bucket'), 'backups');
    await userEvent.type(screen.getByLabelText('S3 access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('S3 secret access key (not the Cloudflare API token value)'), 'secret');
    await userEvent.type(screen.getByLabelText('Snapshot ID or snapshots/ID/ prefix'), '019a0af0-9c00-7000-8000-0000000000cc');
    await userEvent.click(screen.getByLabelText('Backup private key')); await userEvent.paste(privateKey);
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Restore a backup' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([path]) => String(path) === '/api/setup/restore')).toBe(true));
    // The server holds the gym for the restore before it answers the request.
    statusAnswer = gone;
    await reloadStatus(query);
    statusAnswer = null;

    await act(async () => { answerRestore(); });

    expect(await screen.findByText(rejectedText)).toBeDefined();
    await waitFor(() => expect(query.getQueryState(['setup', 'status'])?.status).toBe('success'));
    expect(screen.getByRole('heading', { name: 'Start fresh or restore a backup' })).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
  });

  const pollFailedText = 'Could not read restore progress. Reload this page to retry.';
  /** An answer the test sends when it chooses. */
  function later() {
    let send!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { send = resolve; });
    return { response, send };
  }
  /** Lets requests settle and the screen take their answers. */
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const refocus = () => act(async () => {
    for (const event of ['visibilitychange', 'focus', 'offline', 'online']) window.dispatchEvent(new Event(event));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /** Whether the unavailable screen was ever rendered from here on, however briefly. */
  function watchUnavailable() {
    let shown = false;
    const observer = new MutationObserver(() => { shown ||= Boolean(document.body.textContent?.includes(unavailableText)); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); return shown; };
  }

  it('reads no status on focus or reconnect while the restore request is pending', async () => {
    restorePolls = [running('verifying')];
    const { fetcher } = start(0);
    const base = fetcher.getMockImplementation()!, request = later();
    fetcher.mockImplementation((path, options) => String(path) === '/api/setup/restore' ? request.response : base(path, options));
    await fillRestore();
    const shown = watchUnavailable();
    await sendRestore();
    const before = statusReads(fetcher);

    // The server holds the gym for the restore before it answers the request.
    statusAnswer = gone;
    await refocus();
    expect(statusReads(fetcher)).toBe(before);

    await act(async () => { request.send(Response.json({ data: { status: 'running', jobId: restoreJob, phase: 'verifying' } })); });
    expect(await screen.findByText(restoring)).toBeDefined();
    await settle();
    expect(statusReads(fetcher)).toBe(before);
    expect(shown()).toBe(false);
  });
  it('cancels a status read running when the restore is sent, and reads again when the request fails', async () => {
    const { fetcher, query } = start(0);
    const base = fetcher.getMockImplementation()!, request = later(), read = later();
    let holdRead = false;
    fetcher.mockImplementation((path, options) => {
      if (String(path) === '/api/setup/restore') return request.response;
      if (String(path) === '/api/setup' && holdRead) { holdRead = false; return read.response; }
      return base(path, options);
    });
    await fillRestore();
    holdRead = true;
    await refocus();
    expect(query.getQueryState(['setup', 'status'])?.fetchStatus).toBe('fetching');
    const shown = watchUnavailable();
    await sendRestore();
    await waitFor(() => expect(fetcher.mock.calls.some(([path]) => String(path) === '/api/setup/restore')).toBe(true));
    const before = statusReads(fetcher);
    await act(async () => { read.send(gone()); });
    await settle();
    expect(query.getQueryState(['setup', 'status'])).toMatchObject({ status: 'success', fetchStatus: 'idle' });

    await act(async () => { request.send(serverError()); });

    expect(await screen.findByText('Could not save this step. Check the details and try again.')).toBeDefined();
    await settle();
    expect(statusReads(fetcher)).toBe(before + 1);
    expect(screen.getByLabelText('Backup private key')).toBeDefined();
    expect(shown()).toBe(false);
  });
  it('cancels a first status read still running when the restore has failed, and reads again', async () => {
    sessionStorage.setItem('setup.restore', restoreJob);
    const first = later(), poll = later();
    restorePolls = [() => poll.response];
    // Only the first read is held.
    statusAnswer = () => { statusAnswer = null; return first.response; };
    const { fetcher, query } = start(0);
    await waitFor(() => expect(statusReads(fetcher)).toBe(1));
    const shown = watchUnavailable();

    await act(async () => { poll.send(failed('credentials_rejected', false)()); });
    expect(await screen.findByText(rejectedText)).toBeDefined();
    await act(async () => { first.send(gone()); });
    await settle();

    expect(statusReads(fetcher)).toBe(2);
    expect(query.getQueryState(['setup', 'status'])?.status).toBe('success');
    expect(screen.getByText(rejectedText)).toBeDefined();
    expect(shown()).toBe(false);
  });
  it('reads the status again when the restore poll fails, so a 404 read during the restore does not hide it', async () => {
    sessionStorage.setItem('setup.restore', restoreJob);
    const poll = later();
    restorePolls = [() => poll.response];
    statusAnswer = gone;
    const { fetcher, query } = start(4);
    await waitFor(() => expect(query.getQueryState(['setup', 'status'])?.status).toBe('error'));
    statusAnswer = null;

    await act(async () => { poll.send(Response.json({}, { status: 400 })); });

    expect(await screen.findByRole('heading', { name: 'Your website' })).toBeDefined();
    expect(screen.getByText(pollFailedText)).toBeDefined();
    expect(screen.queryByText(unavailableText)).toBeNull();
    expect(statusReads(fetcher)).toBe(2);
  });
  it('shows the reload alert beside a restore failure when the status has never been read', async () => {
    sessionStorage.setItem('setup.restore', restoreJob);
    const poll = later();
    restorePolls = [() => poll.response];
    statusAnswer = gone;
    const { query } = start(0);
    await waitFor(() => expect(query.getQueryState(['setup', 'status'])?.status).toBe('error'));
    statusAnswer = serverError;

    await act(async () => { poll.send(failed('credentials_rejected', false)()); });

    expect(await screen.findByText(reloadText)).toBeDefined();
    expect(screen.getByText(rejectedText)).toBeDefined();
    const retry = screen.getByRole('button', { name: 'Try again' });

    // A failed retry focuses the new reload alert, and one that works focuses the step's heading.
    await userEvent.click(retry);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText(reloadText).closest('[role="alert"]')));
    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(reloadText)).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Start fresh or restore a backup' })));
    expect(screen.getByText(rejectedText)).toBeDefined();
  });
  it('puts focus on what replaces the loading state after Try again, and never moves it for a background read', async () => {
    statusAnswer = () => Response.json({}, { status: 502 });
    const { fetcher } = start(0);
    await screen.findByText(reloadText);
    const tryAgain = async (reads: number) => {
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(statusReads(fetcher)).toBe(reads));
      await settle();
    };

    await tryAgain(2);
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    statusAnswer = gone;
    await tryAgain(3);
    expect(document.activeElement).toBe(screen.getByText(unavailableText));
    // The same answer again swaps the screen out and back, and focuses it again.
    screen.getByRole('link', { name: 'Sign in' }).focus();
    await tryAgain(4);
    expect(document.activeElement).toBe(screen.getByText(unavailableText));
    statusAnswer = null;
    await tryAgain(5);
    const heading = screen.getByRole('heading', { name: 'Start fresh or restore a backup' });
    expect(document.activeElement).toBe(heading);

    const button = screen.getByRole('button', { name: 'Start fresh' });
    button.focus();
    statusAnswer = serverError;
    await refocus();
    expect(await screen.findByText(reloadText)).toBeDefined();
    expect(document.activeElement).toBe(button);
    // A retry from a screen that has status data moves no focus when it works.
    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(reloadText)).toBeNull());
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
  it('focuses the step heading when Try again works on an unavailable screen reached after a status read', async () => {
    start(0);
    await screen.findByRole('heading', { name: 'Start fresh or restore a backup' });
    statusAnswer = gone;
    await refocus();
    expect(await screen.findByText(unavailableText)).toBeDefined();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const heading = await screen.findByRole('heading', { name: 'Start fresh or restore a backup' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
  it('says the setup changed once a later read works after the reload of a 409 failed', async () => {
    await saveGymAnswering409(serverError);
    await screen.findByText(reloadText);
    expect(screen.queryByText(changedText)).toBeNull();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    const message = await screen.findByText(changedText);
    await settle();
    expect(screen.getAllByText(changedText)).toHaveLength(1);
    expect(screen.queryByText(reloadText)).toBeNull();
    expect(document.activeElement).toBe(message.closest('[role="alert"]'));
  });
  it('leaves focus where it is when a background read brings the late conflict message', async () => {
    await saveGymAnswering409(serverError);
    await screen.findByText(reloadText);
    const field = screen.getByLabelText('Gym name');
    field.focus();

    statusAnswer = null;
    await refocus();

    expect(await screen.findByText(changedText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(field);
  });
  it('drops the pending conflict message when another save starts', async () => {
    const { fetcher } = await saveGymAnswering409(serverError);
    await screen.findByText(reloadText);
    const answer409 = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/gym')
      ? Promise.resolve(Response.json({}, { status: 500 })) : answer409(path, options));
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Could not save this step. Check the details and try again.')).toBeDefined();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(reloadText)).toBeNull());
    await settle();

    expect(screen.queryByText(changedText)).toBeNull();
    expect(screen.getByText('Could not save this step. Check the details and try again.')).toBeDefined();
  });

  const saveFailedText = 'Could not save this step. Check the details and try again.';
  /** Sends a restore request that answers 500, with the status read after it answering `reload` (the usual status when null). */
  async function failRestoreRequest(reload: (() => Response | Promise<Response>) | null) {
    const started = start(0);
    const base = started.fetcher.getMockImplementation()!;
    started.fetcher.mockImplementation((path, options) => String(path) === '/api/setup/restore'
      ? Promise.resolve(serverError()) : base(path, options));
    await fillRestore();
    const before = statusReads(started.fetcher);
    statusAnswer = reload;
    await sendRestore();
    return { ...started, before };
  }
  const alertOf = (text: string) => screen.getByText(text).closest('[role="alert"]');
  it('keeps the focus on the save error when the restore request and the status read after it both fail', async () => {
    // The status read answers only once the save error is on screen, as over a real connection.
    const read = later();
    const { fetcher, before } = await failRestoreRequest(() => read.response);
    expect(await screen.findByText(saveFailedText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(saveFailedText));

    statusAnswer = serverError;
    await act(async () => { read.send(serverError()); });

    expect(await screen.findByText(reloadText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(saveFailedText));
    expect(statusReads(fetcher)).toBe(before + 1);

    // A retry the owner asks for still takes the focus to the reload alert when it fails too.
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(document.activeElement).toBe(alertOf(reloadText)));
    expect(statusReads(fetcher)).toBe(before + 2);
  });
  it('shows only the save error, focused, when the status read after a failed restore request works', async () => {
    const { fetcher, before } = await failRestoreRequest(null);

    expect(await screen.findByText(saveFailedText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(saveFailedText));
    expect(statusReads(fetcher)).toBe(before + 1);
    expect(screen.queryByText(reloadText)).toBeNull();
  });

  it('keeps the focus on the sign-in error when the status read moves the owner step on', async () => {
    const ownerSavedSignInFailed = "Your owner account was saved, but signing in didn't finish. Sign in as the owner to continue setup.";
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: null,
      login: { password: true, magicLink: false },
    });
    vi.mocked(services.signInWithPassword).mockRejectedValueOnce(new Error('sign-in failed'));
    start(1);
    await userEvent.type(await screen.findByLabelText('Your name'), 'Gym Owner');
    await userEvent.type(screen.getByLabelText('Email address'), 'owner@example.org');
    await userEvent.type(screen.getByLabelText('Password (12–128 characters)'), 'owner-password-123');
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByRole('heading', { name: 'Gym details' })).toBeDefined();
    expect(await screen.findByText(ownerSavedSignInFailed)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(ownerSavedSignInFailed));
  });
  it('keeps the focus on the conflict message when the reload after a 409 moves the step', async () => {
    // The signed-in owner, whatever an earlier test left the bootstrap answering.
    vi.mocked(services.loadBootstrap).mockResolvedValue({
      gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] },
      session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false },
      login: { password: true, magicLink: false },
    });
    await saveGymAnswering409(() => Response.json({ data: { currentStep: 4, completedSteps: [0, 1, 2, 3], completed: false, revision: 3, googleSkipped: false, backupsLater: false } }));

    expect(await screen.findByRole('heading', { name: 'Your website' })).toBeDefined();
    expect(await screen.findByText(changedText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(changedText));
  });

  const unansweredText = 'The restore request got no answer, so the restore may be running. Wait a few minutes, then reload this page; once the restore has finished, it shows the sign-in page.';
  /** Sends a restore request that ends as `request` says, with the status read after it answering `reload` (the usual status when null). */
  async function sendRestoreEnding(request: () => Promise<Response>, reload: (() => Response | Promise<Response>) | null) {
    const started = start(0);
    const base = started.fetcher.getMockImplementation()!;
    started.fetcher.mockImplementation((path, options) => String(path) === '/api/setup/restore' ? request() : base(path, options));
    await fillRestore();
    const before = statusReads(started.fetcher);
    statusAnswer = reload;
    const shown = watchUnavailable();
    await sendRestore();
    return { ...started, before, shown };
  }
  const dropped = () => Promise.reject(new TypeError('Failed to fetch'));
  const proxyAnswer = (status: number) => () => Promise.resolve(new Response('Bad gateway', { status }));

  it.each([
    ['gets no response', dropped],
    ['answers 502', proxyAnswer(502)],
    ['answers 504', proxyAnswer(504)],
  ])('keeps the restore form, saying the restore may be running, when the request %s and the status read answers 404', async (_, request) => {
    // The status read answers only after a while, as over a real connection.
    const read = later();
    const { fetcher, before, shown } = await sendRestoreEnding(request, () => read.response);
    await waitFor(() => expect(statusReads(fetcher)).toBe(before + 1));
    await settle();
    expect(screen.queryByText(saveFailedText)).toBeNull();

    await act(async () => { read.send(gone()); });

    expect(await screen.findByText(unansweredText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(unansweredText));
    expect(screen.getByLabelText('Backup private key')).toHaveProperty('value', privateKey);
    expect(screen.getByLabelText('S3-compatible endpoint URL')).toBeDefined();
    expect(screen.queryByText(saveFailedText)).toBeNull();
    expect(screen.queryByText(reloadText)).toBeNull();
    expect(statusReads(fetcher)).toBe(before + 1);

    // A later read that meets the restore's hold leaves the form and the message too.
    statusAnswer = gone;
    await refocus();
    await settle();
    expect(statusReads(fetcher)).toBe(before + 2);
    expect(screen.getByText(unansweredText)).toBeDefined();
    expect(screen.getByLabelText('Backup private key')).toBeDefined();
    expect(shown()).toBe(false);

    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(unavailableText)).toBeDefined();
    expect(screen.queryByLabelText('Backup private key')).toBeNull();
  });
  it('shows the save error, as before, when an unanswered restore request is followed by a status read that works', async () => {
    const { fetcher, before } = await sendRestoreEnding(dropped, null);

    expect(await screen.findByText(saveFailedText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(saveFailedText));
    expect(screen.queryByText(unansweredText)).toBeNull();
    expect(screen.getByLabelText('Backup private key')).toBeDefined();
    expect(statusReads(fetcher)).toBe(before + 1);
  });
  it('shows the save error and the reload alert when the status read after an unanswered restore request fails too', async () => {
    const { fetcher, before } = await sendRestoreEnding(dropped, serverError);

    expect(await screen.findByText(saveFailedText)).toBeDefined();
    expect(await screen.findByText(reloadText)).toBeDefined();
    await settle();
    expect(document.activeElement).toBe(alertOf(saveFailedText));
    expect(screen.queryByText(unansweredText)).toBeNull();
    expect(statusReads(fetcher)).toBe(before + 1);
  });
  it('shows the unavailable screen when a refused restore request is followed by a 404 status read', async () => {
    const refused = () => Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'Refused' } }, { status: 422 }));
    const { fetcher, before } = await sendRestoreEnding(refused, gone);

    expect(await screen.findByText(unavailableText)).toBeDefined();
    await settle();
    expect(screen.queryByText(unansweredText)).toBeNull();
    expect(screen.queryByLabelText('Backup private key')).toBeNull();
    expect(statusReads(fetcher)).toBe(before + 1);
  });
  it('drops the unanswered message’s hold on the form when a later restore request is refused', async () => {
    const answers = [dropped, () => Promise.resolve(Response.json({ error: { code: 'invalid_request', message: 'Refused' } }, { status: 422 }))];
    await sendRestoreEnding(() => answers.shift()!(), gone);
    expect(await screen.findByText(unansweredText)).toBeDefined();

    await sendRestore();

    expect(await screen.findByText(unavailableText)).toBeDefined();
    expect(screen.queryByLabelText('Backup private key')).toBeNull();
  });
  it('drops the unanswered message on Back, so a later status read that works doesn’t repeat it', async () => {
    await sendRestoreEnding(dropped, gone);
    expect(await screen.findByText(unansweredText)).toBeDefined();
    await userEvent.click(within(screen.getByRole('group', { name: 'Setup actions' })).getByRole('button', { name: 'Back' }));
    expect(await screen.findByText(unavailableText)).toBeDefined();

    statusAnswer = null;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('button', { name: 'Start fresh' })).toBeDefined();
    expect(screen.queryByText(unansweredText)).toBeNull();
  });
});

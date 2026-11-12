// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createWebRegistries } from '@plaingym/shared';
import { ShellServicesContext } from '../../app/context.js';
import type { ShellServices } from '../../app/services.js';
import { ApiError } from '../../lib/api.js';
import { SetupWizard } from './wizard.js';
import { createSetupClient } from './api.js';
import { createRegistries, type ExtensionView } from '../../lib/registries.js';

const services: ShellServices = {
  loadBootstrap: vi.fn(async () => ({ gym: { id: 'gym', name: 'Academy', timezone: 'UTC', currency: 'USD', enabledModules: [] }, session: { userId: 'owner', displayName: 'Test User', roles: ['owner'] as const, member: false }, login: { password: true, magicLink: false } })),
  signInWithPassword: vi.fn(async () => {}), requestMagicLink: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
};
const privateKey = 'AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ';
const publicKey = 'age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
/** A faked setup server: its step, revision and the owner's recorded decisions, as `/api/setup` reports them. */
function start(step = 0, completedSteps = Array.from({ length: step }, (_, i) => i), registries = createRegistries(),
  recorded: { googleSkipped?: boolean; backupsLater?: boolean } = {}) {
  let currentStep = step, revision = 1, googleSkipped = recorded.googleSkipped ?? false, backupsLater = recorded.backupsLater ?? false;
  const status = () => ({ currentStep: backupsLater && currentStep === 7 ? 8 : currentStep, completedSteps, completed: false, revision, googleSkipped, backupsLater });
  const fetcher = vi.fn(async (path: RequestInfo | URL, options?: RequestInit) => {
    const name = String(path), body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
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
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('setup wizard', () => {
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
    await userEvent.type(screen.getByLabelText('Storage access key ID'), 'access');
    await userEvent.type(screen.getByLabelText('Storage secret access key'), 'secret');
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
  it('offers an optional Google page after email that stores the client and changes no step', async () => {
    const { fetcher, query } = start(6);
    await screen.findByLabelText('Client ID');
    expect(screen.getByRole('heading', { name: 'Google sign-in (optional)' })).toBeDefined();
    expect(screen.getByText('Step 6 / 9')).toBeDefined();
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
      const input = (await screen.findByLabelText('IANA timezone')) as HTMLInputElement;
      expect(input.value).toBe(expected);
      expect(!!screen.queryByText(hint)).toBe(hinted);
      expect(input.getAttribute('aria-describedby') !== null).toBe(hinted);
    });
    it('drops the fallback hint once the owner edits the field', async () => {
      hostZone(undefined);
      start(2);
      const input = await screen.findByLabelText('IANA timezone');
      expect(screen.queryByText(hint)).not.toBeNull();
      await userEvent.type(input, '/Vancouver');
      expect(screen.queryByText(hint)).toBeNull();
    });
    it('reads the host zone once per wizard mount', async () => {
      hostZone('America/Vancouver');
      start(2);
      const input = await screen.findByLabelText('IANA timezone');
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
    await screen.findByText(/Mail sent directly from the server itself lands in spam/);
    expect(screen.getByText(/SPF and DKIM/)).toBeDefined();
    expect(screen.getByText(/AUTH_PASSWORD_LOGIN=auto/)).toBeDefined();
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
  it('can finish at step 8 after a confirmed key survives a reload', async () => {
    const { fetcher } = start(8, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(await screen.findByText('Import or start fresh')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Back to backups' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: 'Start fresh' }));
    expect(await screen.findByText(/Setup is complete/)).toBeDefined();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
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
  await userEvent.type(screen.getByLabelText('Storage access key ID'), 'access');
  await userEvent.type(screen.getByLabelText('Storage secret access key'), 'private-storage-secret');
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
  it('keeps the failed email test on the form, with the error', async () => {
    const { fetcher } = start(5);
    const answer = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((path, options) => String(path).endsWith('/smtp')
      ? Promise.resolve(Response.json({ data: { configured: false, test: 'failed', revision: 1 } })) : answer(path, options));
    await sendTestEmail();
    expect((await screen.findByRole('alert')).textContent).toContain('The test email failed');
    expect(screen.getByRole('button', { name: 'Send test email and save' })).toBeDefined();
  });
  it('mentions the alternative SMTP port in the email hint', async () => {
    start(5);
    expect(await screen.findByText(/block outgoing email on ports 25, 465 and 587.*such as 2525/)).toBeDefined();
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
    await userEvent.type(screen.getByLabelText('Storage access key ID'), 'a');
    await userEvent.type(screen.getByLabelText('Storage secret access key'), 's');
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
    expect(from.getAttribute('aria-describedby')).toBeNull();
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
    const zone = screen.getByLabelText('IANA timezone');
    await userEvent.clear(zone); await userEvent.type(zone, 'CET'); await userEvent.tab();
    expect(zone.getAttribute('aria-invalid')).toBe('true');
    expect(described(zone)).toContain('Enter an IANA timezone');
    // An optional field left blank shows nothing.
    const address = screen.getByLabelText('Street address');
    await userEvent.click(address); await userEvent.tab();
    expect(address.getAttribute('aria-invalid')).toBeNull();
    expect(described(address)).toBe('');
  });
  it('refuses a backup endpoint that ends with the bucket name', async () => {
    start(7);
    const endpoint = await screen.findByLabelText('S3-compatible endpoint URL');
    await userEvent.type(screen.getByLabelText('Storage bucket'), 'gym-backups');
    await userEvent.type(endpoint, 'https://account.r2.cloudflarestorage.com/gym-backups'); await userEvent.tab();
    expect(endpoint.getAttribute('aria-invalid')).toBe('true');
    expect(described(endpoint)).toContain('Use the address without the bucket name.');
    await userEvent.clear(endpoint); await userEvent.type(endpoint, 'https://account.r2.cloudflarestorage.com');
    expect(described(endpoint)).toContain('Looks right');
    await userEvent.clear(endpoint); await userEvent.type(endpoint, 'not an address');
    expect(described(endpoint)).toContain('Enter a full address starting with https://.');
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
    expect((screen.getByLabelText('Storage secret access key') as HTMLInputElement).value).toBe('');
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

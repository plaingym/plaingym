// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { goLiveChecklistItemSchema, type ChargeType, type GymSettings } from '@plaingym/shared/contracts';
import { GeneralSettingsForm } from './general/form.js';
import { BillingSettings } from './billing.js';
import { DropInSettings } from './drop-in.js';
import { GoLiveSettings } from './go-live.js';
import { holdTimeouts, stalledRequests } from './save-timeout.test-helper.js';
const server = vi.hoisted(() => ({ GET: vi.fn(), PATCH: vi.fn() }));
const billing = vi.hoisted(() => ({ charges: vi.fn() }));
vi.mock('../../lib/api.js', async (original) => ({ ...await original<typeof import('../../lib/api.js')>(), api: server, createApiClient: () => server }));
vi.mock('../billing/catalog/api.js', async (original) => ({ ...await original<typeof import('../billing/catalog/api.js')>(), billingClient: billing }));
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const mat: ChargeType = { id: id(10), createdAt: '2026-10-26T12:00:00Z', name: 'Mat fee', amountCents: 2500, currency: 'CAD', active: true, revision: 1, taxRateIds: [] };
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
let gym: GymSettings;
const checklist = () => ({ data: { revision: gym.revision, billingEnabled: gym.billingEnabled, memberEmailsEnabled: gym.memberEmailsEnabled,
  items: goLiveChecklistItemSchema.shape.id.options.map((item) => ({ id: item, status: 'ready', message: 'Message for ' + item })) } });
/** The server's rule for every save: the revision sent must be the gym's current one, and each save moves it on. */
const fakeServer = () => {
  server.GET.mockImplementation(async (path: string) => reply(200, path === '/api/settings/go-live' ? checklist() : { data: gym }));
  server.PATCH.mockImplementation(async (path: string, { body }: { body: { revision: number } & Record<string, unknown> }) => {
    if (body.revision !== gym.revision) return reply(409);
    const { revision, ...changes } = body;
    gym = { ...gym, ...changes, revision: revision + 1 };
    return reply(200, path === '/api/settings/go-live' ? checklist() : { data: gym });
  });
};
const sections = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })}>
  <GeneralSettingsForm/><BillingSettings/><DropInSettings/><GoLiveSettings/></QueryClientProvider>);
const goLive = () => within(screen.getByRole('region', { name: 'Go-live' }));
const field = async (name: string) => await screen.findByRole('textbox', { name }) as HTMLInputElement;
const bodies = () => server.PATCH.mock.calls.map(([path, { body }]) => [path, body.revision]);
const checklistReads = () => server.GET.mock.calls.filter(([path]) => path === '/api/settings/go-live').length;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  server.GET.mockReset(); server.PATCH.mockReset(); billing.charges.mockReset(); billing.charges.mockResolvedValue([mat]);
  gym = { id: id(1), name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {}, websiteEnabled: false,
    existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false,
    memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: '2026-10-26T12:00:00Z', updatedAt: '2026-10-26T12:00:00Z' };
  fakeServer();
});
afterEach(cleanup);

describe('settings sections on one page', () => {
  it('reads the gym settings once for every section', async () => {
    sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    expect(server.GET.mock.calls.filter(([path]) => path === '/api/settings')).toHaveLength(1);
  });
  it('saves one section after another without a reload, each against the revision the last save produced', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await user.clear(days); await user.type(days, '2, 9'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findAllByText('Retry schedule saved.')).length).toBe(1);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Drop-in charge type' }), mat.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(await screen.findByText('Drop-in fee saved.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    const currency = screen.getByRole('form', { name: 'Billing currency' });
    await user.clear(within(currency).getByLabelText('Billing currency')); await user.type(within(currency).getByLabelText('Billing currency'), 'usd');
    await user.click(within(currency).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(gym.currency).toBe('USD'));
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings/drop-in', 4], ['/api/settings/go-live', 5], ['/api/settings/currency', 6]]);
    expect(gym).toMatchObject({ retryDays: [2, 9], dropInChargeTypeId: mat.id, memberEmailsEnabled: true, revision: 7 });
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(server.GET.mock.calls.filter(([path]) => path === '/api/settings')).toHaveLength(1);
  });
  it('lets two sections save at the same moment', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await user.clear(days); await user.type(days, '5');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Drop-in charge type' }), mat.id);
    await Promise.all([user.click(screen.getByRole('button', { name: 'Save retry schedule' })), user.click(screen.getByRole('button', { name: 'Save drop-in fee' }))]);
    expect(await screen.findByText('Drop-in fee saved.')).toBeDefined();
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    expect(gym).toMatchObject({ retryDays: [5], dropInChargeTypeId: mat.id, revision: 5 });
  });
  it('keeps unsaved input in one section when another section saves', async () => {
    const user = userEvent.setup(); sections();
    const name = await field('Gym name');
    await user.clear(name); await user.type(name, 'Renamed gym');
    const days = await field('Retry days');
    await user.clear(days); await user.type(days, '4'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    expect(name.value).toBe('Renamed gym');
    await user.click(within(screen.getByRole('form', { name: 'Gym details' })).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(gym.name).toBe('Renamed gym'));
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings', 4]]);
  });
  it('answers a change made in another tab with a conflict, then reloads every section', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    // Another tab changed the booking window and turned member emails on after this page loaded.
    gym = { ...gym, bookingWindowDays: 30, memberEmailsEnabled: true, retryDays: [1], revision: 4 };
    await user.clear(days); await user.type(days, '6'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed elsewhere');
    await vi.waitFor(() => expect(days.value).toBe('1'));
    expect((await screen.findByRole('button', { name: 'Turn off: Member emails' }))).toBeDefined();
    expect((screen.getByLabelText('Booking window (days)') as HTMLInputElement).value).toBe('30');
    expect(gym.retryDays).toEqual([1]);
    // The next save goes through against the reloaded revision.
    await user.clear(days); await user.type(days, '6'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings/billing', 4]]);
  });
  it('answers a stale switch with a conflict in the go-live section too', async () => {
    const user = userEvent.setup(); sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    gym = { ...gym, retryDays: [1], revision: 4 };
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByText(/changed elsewhere/)).toBeDefined();
    expect(gym.memberEmailsEnabled).toBe(false);
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/go-live', 3], ['/api/settings/go-live', 4]]);
  });
  it('refuses a save queued behind a conflict, so its values from before the reload never overwrite the other tab\'s change', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days'), name = await field('Gym name');
    await user.clear(days); await user.type(days, '5');
    // Another tab renamed the gym after this page loaded; this page's gym details form still holds the old name.
    gym = { ...gym, name: 'Renamed elsewhere', revision: 4 };
    const details = screen.getByRole('form', { name: 'Gym details' });
    await Promise.all([user.click(screen.getByRole('button', { name: 'Save retry schedule' })), user.click(within(details).getByRole('button', { name: 'Save changes' }))]);
    await vi.waitFor(() => expect(screen.getAllByText(/changed elsewhere/)).toHaveLength(2));
    // Only the first save reached the server, and it got the 409; the queued one was answered without being sent.
    expect(server.PATCH).toHaveBeenCalledTimes(1);
    expect(gym).toMatchObject({ name: 'Renamed elsewhere', retryDays: [3, 7], revision: 4 });
    await vi.waitFor(() => expect((screen.getByRole('textbox', { name: 'Gym name' }) as HTMLInputElement).value).toBe('Renamed elsewhere'));
    expect(name.isConnected).toBe(false);
    // Saved again from the reloaded values, it goes through.
    await user.click(within(screen.getByRole('form', { name: 'Gym details' })).getByRole('button', { name: 'Save changes' }));
    await vi.waitFor(() => expect(gym.revision).toBe(5));
    expect(gym.name).toBe('Renamed elsewhere');
  });
  it('refuses to save over settings whose reload failed, and saves again after a reload', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    gym = { ...gym, retryDays: [1], revision: 4 };
    const read = server.GET.getMockImplementation()!;
    server.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(500) : read(path));
    await user.clear(days); await user.type(days, '6'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    // The save answered 409, so the section says the settings changed, not that the request failed generically.
    const alerts = async () => (await screen.findAllByRole('alert')).map((alert) => alert.textContent).join(' ');
    expect(await alerts()).toContain('changed elsewhere');
    expect(await alerts()).toContain('The request failed');
    await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(server.PATCH).toHaveBeenCalledTimes(1);
    server.GET.mockImplementation(read);
    await user.click(screen.getByRole('button', { name: 'Reload saved schedule' }));
    await vi.waitFor(() => expect(days.value).toBe('1'));
    await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
  });
  it('reloads the settings when a saved response does not parse, so the next save has the right revision', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    const apply = server.PATCH.getMockImplementation()!;
    server.PATCH.mockImplementationOnce(async (path: string, options: { body: { revision: number } & Record<string, unknown> }) => {
      await apply(path, options);
      return reply(200, { data: { unexpected: true } });
    });
    await user.clear(days); await user.type(days, '2'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The request failed');
    await user.clear(days); await user.type(days, '8'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings/billing', 4]]);
  });
  it('holds the go-live switches while the checklist is older than another section\'s save', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    const read = server.GET.getMockImplementation()!;
    server.GET.mockImplementation(async (path: string) => path === '/api/settings/go-live' ? reply(500) : read(path));
    await user.clear(days); await user.type(days, '2'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    const toggle = await screen.findByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement;
    await vi.waitFor(() => expect(toggle.disabled).toBe(true));
    server.GET.mockImplementation(read);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
  });
  it('refreshes the go-live checklist after another section saves', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    const before = server.GET.mock.calls.filter(([path]) => path === '/api/settings/go-live').length;
    await user.clear(days); await user.type(days, '2'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    await vi.waitFor(() => expect(server.GET.mock.calls.filter(([path]) => path === '/api/settings/go-live')).toHaveLength(before + 1));
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings/go-live', 4]]);
  });
  it('refuses a go-live switch clicked while another section\'s save is in flight, and reads the checklist again once', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    const apply = server.PATCH.getMockImplementation()!, sending = deferred(), started = deferred();
    server.PATCH.mockImplementationOnce(async (path: string, options: { body: { revision: number } & Record<string, unknown> }) => {
      started.resolve(); await sending.promise; return apply(path, options);
    });
    const before = checklistReads();
    await user.clear(days); await user.type(days, '2'); await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    await started.promise;
    // The switch is clicked with the checklist read before this save, which the server has not finished.
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    sending.resolve();
    // The change was this page's own save, so the message doesn't blame another user.
    expect(await goLive().findByText('Settings were just saved on this page. Check what is shown and try again.')).toBeDefined();
    expect(screen.queryByText(/changed elsewhere/)).toBeNull();
    expect(await screen.findByText('Retry schedule saved.')).toBeDefined();
    const toggle = await screen.findByRole('button', { name: 'Turn on: Member emails' }) as HTMLButtonElement;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(bodies()).toEqual([['/api/settings/billing', 3]]);
    expect(gym.memberEmailsEnabled).toBe(false);
    expect(checklistReads()).toBe(before + 1);
    // From the refreshed checklist the same click goes through.
    await user.click(toggle);
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/billing', 3], ['/api/settings/go-live', 4]]);
  });
  it('reads the go-live checklist once after a conflict', async () => {
    const user = userEvent.setup(); sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    // Another tab turned member emails on after this page loaded.
    gym = { ...gym, memberEmailsEnabled: true, revision: 4 };
    const before = checklistReads();
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByText(/These settings changed elsewhere/)).toBeDefined();
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(checklistReads()).toBe(before + 1);
    expect(bodies()).toEqual([['/api/settings/go-live', 3]]);
  });
  it('shows one alert with one Try again in go-live when the reload after a conflict fails, and holds the switches until it is retried', async () => {
    const user = userEvent.setup(); sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    gym = { ...gym, memberEmailsEnabled: true, revision: 4 };
    const read = server.GET.getMockImplementation()!;
    server.GET.mockImplementation(async (path: string) => path === '/api/settings' ? reply(500) : read(path));
    const before = checklistReads();
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    await vi.waitFor(() => expect(goLive().getAllByRole('alert')).toHaveLength(1));
    // The one alert says why the switch didn't change, and that the latest values couldn't be read.
    expect(goLive().getByRole('alert').textContent).toContain('These settings changed elsewhere, so the switch was not changed');
    expect(goLive().getByRole('alert').textContent).toContain('The request failed');
    expect(goLive().getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    const toggle = await goLive().findByRole('button', { name: 'Turn off: Member emails' }) as HTMLButtonElement;
    expect(checklistReads()).toBe(before + 1);
    expect(toggle.disabled).toBe(true);
    // The settings can be reloaded from this section, after which the switch works.
    server.GET.mockImplementation(read);
    await user.click(goLive().getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(goLive().queryByRole('alert')).toBeNull();
    await user.click(toggle);
    expect(await goLive().findByRole('button', { name: 'Turn on: Member emails' })).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/go-live', 3], ['/api/settings/go-live', 4]]);
  });
  it('shows one alert and one Try again in go-live when the settings and the checklist both fail to load, and retries both reads', async () => {
    const read = server.GET.getMockImplementation()!;
    server.GET.mockImplementation(async (path: string) => path === '/api/settings' || path === '/api/settings/go-live' ? reply(500) : read(path));
    const user = userEvent.setup(); sections();
    await vi.waitFor(() => expect(goLive().getAllByRole('alert')).toHaveLength(1));
    expect(goLive().getAllByRole('button', { name: 'Try again' })).toHaveLength(1);
    server.GET.mockImplementation(read);
    await user.click(goLive().getByRole('button', { name: 'Try again' }));
    expect(await goLive().findByRole('button', { name: 'Turn on: Member emails' })).toBeDefined();
    expect(goLive().queryByRole('alert')).toBeNull();
  });
  it('keeps every section\'s input when a go-live save is refused for something other than the gym revision', async () => {
    const user = userEvent.setup(); sections();
    const days = await field('Retry days');
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    await user.clear(days); await user.type(days, '6');
    // A past-due membership's revision moved; the gym's did not.
    server.PATCH.mockImplementationOnce(async () => reply(409));
    const before = checklistReads();
    await user.click(screen.getByRole('button', { name: 'Turn on: Member emails' }));
    expect(await goLive().findByText(/These settings changed elsewhere/)).toBeDefined();
    await vi.waitFor(() => expect(checklistReads()).toBe(before + 1));
    expect(days.isConnected).toBe(true);
    expect(days.value).toBe('6');
    expect(gym.revision).toBe(3);
    // From the checklist read again the same click goes through against the unchanged revision.
    await user.click(await screen.findByRole('button', { name: 'Turn on: Member emails' }));
    expect(await screen.findByRole('button', { name: 'Turn off: Member emails' })).toBeDefined();
    expect(bodies()).toEqual([['/api/settings/go-live', 3], ['/api/settings/go-live', 3]]);
    expect(days.value).toBe('6');
  });

  type User = ReturnType<typeof userEvent.setup>;
  const submit = (form: string) => async (user: User) => user.click(within(screen.getByRole('form', { name: form })).getByRole('button', { name: 'Save changes' }));
  const saves: Array<[string, string, (user: User) => Promise<void>, RegExp]> = [
    ['the retry schedule', '/api/settings/billing', async (user) => {
      const days = await field('Retry days'); await user.clear(days); await user.type(days, '5');
      await user.click(screen.getByRole('button', { name: 'Save retry schedule' }));
    }, /Check the schedule shown before saving again/],
    ['the drop-in fee', '/api/settings/drop-in', async (user) => {
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Drop-in charge type' }), mat.id);
      await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    }, /Check the drop-in fee shown before saving again/],
    ['the gym details', '/api/settings', submit('Gym details'), /Check the settings shown before saving again/],
    ['the booking rules', '/api/settings/booking', submit('Class and booking rules'), /Check the settings shown before saving again/],
    ['the currency', '/api/settings/currency', submit('Billing currency'), /Check the settings shown before saving again/],
    ['a go-live switch', '/api/settings/go-live', (user) => user.click(screen.getByRole('button', { name: 'Turn on: Member emails' })),
      /Check the switches shown before trying again/],
  ];
  it.each(saves)('aborts %s when its save times out, reloads the settings and says it may still have gone through', async (_name, path, act, said) => {
    const user = userEvent.setup(); sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    await screen.findByRole('combobox', { name: 'Drop-in charge type' });
    const settingsReads = () => server.GET.mock.calls.filter(([read]) => read === '/api/settings').length, reads = settingsReads();
    const stalled = stalledRequests(), timers = holdTimeouts();
    try {
      server.PATCH.mockImplementation(stalled.answer);
      await act(user);
      await vi.waitFor(() => expect(stalled.signals).toHaveLength(1));
      expect(server.PATCH).toHaveBeenCalledWith(path, expect.objectContaining({ signal: stalled.signals[0] }));
      expect(stalled.signals[0]!.aborted).toBe(false);
      timers.expire();
      expect(stalled.signals[0]!.aborted).toBe(true);
      expect(await screen.findByText(said)).toBeDefined();
      expect(settingsReads()).toBe(reads + 1);
      expect(screen.queryByText(/The request failed|Unable to save/)).toBeNull();
    } finally { timers.restore(); }
  });
  it.each([
    ['Retry days', '5', 'Save retry schedule', 'Something changed elsewhere, so the schedule wasn’t saved', 'Settings changed elsewhere. The latest saved schedule is shown'],
  ])('words a conflict on %s by whether the latest settings are shown', async (label, typed, button, kept, moved) => {
    const user = userEvent.setup(); sections();
    const days = await field(label);
    await user.clear(days); await user.type(days, typed);
    // Refused for something the gym revision doesn't cover: the entry stays, and so does the gym.
    server.PATCH.mockImplementationOnce(async () => reply(409));
    await user.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByText(new RegExp(kept))).toBeDefined();
    expect(days.value).toBe(typed);
    // Another tab saved: the reload shows the latest values.
    gym = { ...gym, retryDays: [8], revision: 4 };
    server.PATCH.mockImplementationOnce(async () => reply(409));
    await user.click(screen.getByRole('button', { name: button }));
    expect(await screen.findByText(new RegExp(moved))).toBeDefined();
    await vi.waitFor(() => expect(days.value).toBe('8'));
  });
  it('words a conflict on the general, drop-in and go-live forms by whether the latest settings are shown', async () => {
    const user = userEvent.setup(); sections();
    await screen.findByRole('button', { name: 'Turn on: Billing' });
    const name = within(screen.getByRole('form', { name: 'Gym details' })).getByLabelText('Gym name') as HTMLInputElement;
    await user.clear(name); await user.type(name, 'Typed');
    server.PATCH.mockImplementationOnce(async () => reply(409));
    await submit('Gym details')(user);
    expect(await screen.findByText(/so your changes weren't saved. They're still in the form/)).toBeDefined();
    expect(name.value).toBe('Typed');
    server.PATCH.mockImplementationOnce(async () => reply(409));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Drop-in charge type' }), mat.id);
    await user.click(screen.getByRole('button', { name: 'Save drop-in fee' }));
    expect(await screen.findByText(/so the drop-in fee wasn’t saved/)).toBeDefined();
    gym = { ...gym, name: 'Renamed elsewhere', revision: 4 };
    server.PATCH.mockImplementationOnce(async () => reply(409));
    await submit('Gym details')(user);
    expect(await screen.findByText(/Settings changed elsewhere. The latest values are shown/)).toBeDefined();
    await vi.waitFor(() => expect((within(screen.getByRole('form', { name: 'Gym details' })).getByLabelText('Gym name') as HTMLInputElement).value).toBe('Renamed elsewhere'));
  });
});

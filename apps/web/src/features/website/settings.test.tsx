// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GymSettings, WebsiteSettings as WebsiteSettingsData } from '@plaingym/shared/contracts';
import { createRegistries } from '../../lib/registries.js';
import { WebsiteSettings } from './settings.js';
import { prepareImage } from './images.js';
import { gymSettingsKey } from '../settings/gym-settings.js';

const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() }));
vi.mock('../../lib/api.js', async (original) => ({ ...await original<typeof import('../../lib/api.js')>(), api: client, createApiClient: () => client }));
const id = (n: number) => '01900000-0000-7000-8000-' + String(n).padStart(12, '0');
const gym: GymSettings = { id: id(1), name: 'Gym', slug: 'gym', timezone: 'America/Vancouver', currency: 'CAD', address: {}, branding: {},
  websiteEnabled: true, existingSiteUrl: null, bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false,
  billingEnabled: false, memberEmailsEnabled: false, retryDays: [3, 7], dropInChargeTypeId: null, revision: 4,
  createdAt: '2026-11-03T12:00:00Z', updatedAt: '2026-11-03T12:00:00Z' };
const website: WebsiteSettingsData = { revision: 4, tagline: 'Train with friends', about: 'Since 2010', phone: null, email: null,
  accentColor: null, primaryColor: '#123456', logo: false, logoVersion: null, photos: [{ id: id(10), alt: 'Mats' }, { id: id(11), alt: 'Class' }] };
const reply = (status: number, data?: unknown) => ({ response: { ok: status < 300, status }, data });
let cache: QueryClient, stored: WebsiteSettingsData;
const start = () => render(<QueryClientProvider client={cache}><WebsiteSettings/></QueryClientProvider>);

beforeEach(() => {
  for (const method of Object.values(client)) method.mockReset();
  stored = website;
  client.GET.mockImplementation(async (path: string) => path === '/api/website' ? reply(200, { data: stored }) : reply(200, { data: { ...gym, revision: stored.revision } }));
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('website settings', () => {
  it('registers a settings section that shows only while the website module is on', () => {
    const sections = createRegistries().settingsSections;
    const section = sections.all().find((entry) => entry.id === 'settingsSections.website');
    expect(section).toMatchObject({ enabled: true, moduleId: 'website', labelKey: 'website/website:title',
      permission: { kind: 'staff', capability: 'settings.manage' }, component: WebsiteSettings });
    expect(sections.forModules(new Set()).some((entry) => entry.id === 'settingsSections.website')).toBe(false);
    expect(sections.forModules(new Set(['website'])).some((entry) => entry.id === 'settingsSections.website')).toBe(true);
  });

  it('saves text and photo order without sending a stored legacy accent or rereading the website', async () => {
    stored = { ...website, accentColor: '#abcdef' };
    const user = userEvent.setup();
    client.PUT.mockImplementation(async (_path: string, { body }: { body: Record<string, unknown> }) => {
      stored = { ...website, ...body, accentColor: null, revision: 5, logo: false } as WebsiteSettingsData;
      return reply(200, { data: stored });
    });
    start();
    const tagline = await screen.findByRole('textbox', { name: 'Tagline' });
    await user.clear(tagline); await user.type(tagline, '  Strong together ');
    await user.type(screen.getByRole('textbox', { name: 'Public phone number' }), '604 555 0100');
    expect(screen.queryByLabelText('Primary color')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Use an accent color for the website footer' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Change your brand color in Gym details' }).getAttribute('href')).toBe('#settingsSections.settings.general');
    const second = screen.getAllByRole('listitem')[1]!;
    await user.click(within(second).getByRole('button', { name: 'Move up' }));
    const reads = client.GET.mock.calls.filter(([path]) => path === '/api/website').length;
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    await screen.findByText('Website saved.');
    expect(client.PUT).toHaveBeenCalledWith('/api/website', expect.objectContaining({ body: { revision: 4, tagline: 'Strong together', about: 'Since 2010',
      phone: '604 555 0100', email: null, primaryColor: '#123456', photos: [{ id: id(11), alt: 'Class' }, { id: id(10), alt: 'Mats' }] } }));
    await waitFor(() => expect(cache.getQueryData<{ settings: GymSettings }>(gymSettingsKey)?.settings.revision).toBe(5));
    expect(client.GET.mock.calls.filter(([path]) => path === '/api/website')).toHaveLength(reads);
  });

  it('removes a photo on save and explains a conflict', async () => {
    const user = userEvent.setup();
    client.PUT.mockResolvedValue(reply(409, { error: { code: 'conflict' } }));
    start();
    const first = (await screen.findAllByRole('listitem'))[0]!;
    await user.click(within(first).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText('Removed photos are deleted when you save.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'These settings changed elsewhere. They have been reloaded; check them and save again.');
    expect(client.PUT.mock.calls[0]![1].body.photos).toEqual([{ id: id(11), alt: 'Class' }]);
  });
  it('reads a later settings reload even when it returns the revision of the last website save', async () => {
    client.PUT.mockImplementation(async () => {
      stored = { ...stored, revision: 5, tagline: 'Saved line' };
      return reply(200, { data: stored });
    });
    const user = userEvent.setup(); start();
    await screen.findByRole('textbox', { name: 'Tagline' });
    const epoch = cache.getQueryData<{ epoch: number }>(gymSettingsKey)?.epoch;
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    await screen.findByDisplayValue('Saved line');
    await waitFor(() => expect(cache.getQueryData<{ epoch: number }>(gymSettingsKey)?.epoch).not.toBe(epoch));
    stored = { ...stored, tagline: 'Restored line', photos: [{ id: id(10), alt: 'Restored mats' }] };
    await act(() => cache.refetchQueries({ queryKey: gymSettingsKey }));
    await screen.findByDisplayValue('Restored line');
    expect(screen.getByDisplayValue('Restored mats')).toBeDefined();
  });

  it('refreshes a color another section saved and saves unsaved text on the first try', async () => {
    const user = userEvent.setup();
    client.PUT.mockImplementation(async (_path: string, { body }: { body: Record<string, unknown> }) => {
      stored = { ...stored, ...body, revision: stored.revision + 1 } as WebsiteSettingsData;
      return reply(200, { data: stored });
    });
    start();
    const tagline = await screen.findByRole('textbox', { name: 'Tagline' });
    await user.clear(tagline); await user.type(tagline, 'Unsaved line');
    // General saves a new primary color: the shared settings move to revision 5 without a reload.
    stored = { ...stored, revision: 5, primaryColor: '#ff0000', photos: [{ id: id(10), alt: 'Mats on the floor' }, { id: id(11), alt: 'Class' }] };
    cache.setQueryData<{ settings: GymSettings; epoch: number }>(gymSettingsKey, (old) => old && { epoch: old.epoch, settings: { ...old.settings, revision: 5, branding: { primaryColor: '#ff0000' } } });
    await screen.findByDisplayValue('Mats on the floor');
    expect((screen.getByRole('textbox', { name: 'Tagline' }) as HTMLInputElement).value).toBe('Unsaved line');
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    await screen.findByText('Website saved.');
    expect(client.PUT).toHaveBeenCalledTimes(1);
    expect(client.PUT).toHaveBeenCalledWith('/api/website', expect.objectContaining({ body: expect.objectContaining({ revision: 5, tagline: 'Unsaved line',
      primaryColor: '#ff0000', photos: [{ id: id(10), alt: 'Mats on the floor' }, { id: id(11), alt: 'Class' }] }) }));
  });

  it('still saves, and explains the conflict, when the website read is newer than the shared settings', async () => {
    const user = userEvent.setup();
    // Another tab saved between the two reads: the website answers revision 6 while the shared settings hold 4.
    stored = { ...website, revision: 6 };
    client.GET.mockImplementation(async (path: string) => path === '/api/website' ? reply(200, { data: stored }) : reply(200, { data: gym }));
    client.PUT.mockResolvedValue(reply(409, { error: { code: 'conflict' } }));
    start();
    await screen.findByRole('textbox', { name: 'Tagline' });
    const save = screen.getByRole('button', { name: 'Save website' }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'These settings changed elsewhere. They have been reloaded; check them and save again.');
    expect(client.PUT).toHaveBeenCalledTimes(1);
  });

  it.each([409, 404])('aborts a reload after a %s when a newer revision read starts', async status => {
    const user = userEvent.setup();
    start(); await screen.findByRole('textbox', { name: 'Tagline' });
    let finish!: (value: ReturnType<typeof reply>) => void;
    const older = new Promise<ReturnType<typeof reply>>(resolve => { finish = resolve; });
    let oldSignal: AbortSignal | undefined;
    client.GET.mockImplementation(async (path: string, options?: { signal?: AbortSignal }) => {
      if (path !== '/api/website') return reply(200, { data: gym });
      oldSignal = options?.signal;
      return older;
    });
    client.PUT.mockResolvedValue(reply(status));
    await user.click(screen.getByRole('button', { name: 'Save website' }));
    await waitFor(() => expect(oldSignal).toBeDefined());
    client.GET.mockImplementation(async (path: string) => path === '/api/website'
      ? reply(200, { data: { ...website, revision: 5, tagline: 'Newer server text' } }) : reply(200, { data: gym }));
    act(() => cache.setQueryData<{ settings: GymSettings; epoch: number }>(gymSettingsKey,
      old => old && { ...old, settings: { ...old.settings, revision: 5 } }));
    await screen.findByDisplayValue('Newer server text');
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { finish(reply(200, { data: website })); await older; });
    expect(screen.getByRole('textbox', { name: 'Tagline' })).toHaveProperty('value', 'Newer server text');
  });

  it('aborts a retry read when the section unmounts', async () => {
    const user = userEvent.setup();
    client.GET.mockImplementation(async (path: string) => path === '/api/website' ? reply(500) : reply(200, { data: gym }));
    const view = start(); await screen.findByRole('button', { name: 'Reload' });
    let finish!: (value: ReturnType<typeof reply>) => void;
    const pending = new Promise<ReturnType<typeof reply>>(resolve => { finish = resolve; });
    let signal: AbortSignal | undefined;
    client.GET.mockImplementation(async (path: string, options?: { signal?: AbortSignal }) => {
      if (path !== '/api/website') return reply(200, { data: gym });
      signal = options?.signal; return pending;
    });
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(signal?.aborted).toBe(false);
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { finish(reply(200, { data: website })); await pending; });
  });

  it('uploads a photo without losing unsaved text, and uploads and removes the logo', async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3200, height: 1600, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation((type?: string) => `data:${type};base64,Ynl0ZXM=`);
    client.POST.mockImplementation(async (path: string) => {
      stored = path === '/api/website/logo' ? { ...stored, revision: stored.revision + 1, logo: true, logoVersion: '123456abcdef' }
        : { ...stored, revision: stored.revision + 1, photos: [...stored.photos, { id: id(12), alt: '' }] };
      return reply(200, { data: stored });
    });
    client.DELETE.mockImplementation(async () => { stored = { ...stored, revision: stored.revision + 1, logo: false, logoVersion: null }; return reply(200, { data: stored }); });
    start();
    const tagline = await screen.findByRole('textbox', { name: 'Tagline' });
    await user.clear(tagline); await user.type(tagline, 'Unsaved line');
    await user.upload(screen.getByLabelText('Add a photo (PNG, JPEG or WebP)'), new File(['jpeg'], 'mats.jpg', { type: 'image/jpeg' }));
    await screen.findByText('Photo added. Describe it for people using screen readers, then save.');
    expect(client.POST).toHaveBeenCalledWith('/api/website/photos', expect.objectContaining({ body: { revision: 4, base64: 'Ynl0ZXM=', contentType: 'image/jpeg', alt: '' } }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect((screen.getByRole('textbox', { name: 'Tagline' }) as HTMLInputElement).value).toBe('Unsaved line');
    await user.upload(screen.getByLabelText('Upload a logo (PNG, JPEG or WebP)'), new File(['png'], 'logo.png', { type: 'image/png' }));
    expect((await screen.findByRole('img', { name: 'Current logo' })).getAttribute('src')).toBe('/public/pages/logo/123456abcdef');
    expect(client.POST).toHaveBeenLastCalledWith('/api/website/logo', expect.objectContaining({ body: { revision: 5, base64: 'Ynl0ZXM=', contentType: 'image/png' } }));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Tagline' }) as HTMLInputElement).value).toBe('Unsaved line'));
    await user.click(screen.getByRole('button', { name: 'Remove logo' }));
    await screen.findByText('Logo removed.');
    expect(client.DELETE).toHaveBeenCalledWith('/api/website/logo', expect.objectContaining({ body: { revision: 6 } }));
    expect(close).toHaveBeenCalled();
  });

  it('says so when the install refuses uploads', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,Ynl0ZXM=');
    client.POST.mockResolvedValue(reply(403, { error: { code: 'forbidden' } }));
    start();
    await user.upload(await screen.findByLabelText('Upload a logo (PNG, JPEG or WebP)'), new File(['png'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This install doesn’t accept uploads, so the logo and photos can’t be changed here.');
  });

  it('refuses an image type the server would refuse, before decoding it', async () => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode);
    await expect(prepareImage(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }), 'logo')).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  });

  it('shrinks a photo until it fits the upload limit', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })));
    const sizes: number[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: (_image: unknown, _x: number, _y: number, width: number) => { sizes.push(width); }, fillRect: vi.fn() } as unknown as CanvasRenderingContext2D);
    let calls = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => 'data:image/jpeg;base64,' + (calls++ === 0 ? 'A'.repeat(800_000) : 'Ynl0ZXM='));
    expect(await prepareImage(new File(['jpeg'], 'big.jpg', { type: 'image/jpeg' }), 'photo')).toEqual({ base64: 'Ynl0ZXM=', contentType: 'image/jpeg' });
    expect(sizes).toEqual([1600, 1200]);
  });
});

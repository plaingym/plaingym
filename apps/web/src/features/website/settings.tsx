// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { maxWebsitePhotos, websiteSettingsResponseSchema, type GymSettings, type WebsiteSettings as WebsiteSettingsData } from '@plaingym/shared/contracts';
import { bootstrapKey } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { useGymSettings } from '../settings/gym-settings.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField, Textarea } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { prepareImage } from './images.js';

const text = (key: string, values?: Record<string, string>) => t('website/website:' + key, values);
const maxPhotos = maxWebsitePhotos;
type Draft = Omit<WebsiteSettingsData, 'revision' | 'logo'>;
const draftOf = ({ revision: _revision, logo: _logo, ...draft }: WebsiteSettingsData): Draft => draft;
type Sent = { response: { ok: boolean; status: number }; data?: unknown };
const defaultPrimary = '#155e55', defaultAccent = '#e3eeec';

function Field({ label, help, children }: { label: string; help?: string; children: (describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  return <div className="grid min-w-0 gap-2">
    <Label className="grid min-w-0 gap-2">{label}{children(help ? id : undefined)}</Label>
    {help && <p id={id} className="text-sm text-muted-foreground">{help}</p>}
  </div>;
}

/**
 * The website's customization: logo, colors, text and photos. Saves share the gym settings revision with the other
 * sections (`useGymSettings`), and each save reloads the gym settings afterwards, so a section showing the logo or the
 * primary color (General) can't save back what it showed before.
 */
export function WebsiteSettings() {
  const cache = useQueryClient(), gym = useGymSettings();
  const [state, setState] = useState<{ data: WebsiteSettingsData; draft: Draft; dirty: boolean } | null>(null);
  const [failed, setFailed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  /**
   * Shows settings from the server. With `keepEdits`, unsaved edits survive a reload, an upload or a logo change: the draft keeps
   * its text and colors, drops photos the server no longer has and adds the ones it didn't know about. A value the server
   * changed since the draft was read (another section, tab or user saved it) replaces the draft's, so saving again can't
   * overwrite a change nobody here has seen.
   */
  function show(loaded: WebsiteSettingsData, keepEdits: boolean) {
    setState((current) => {
      if (!current?.dirty || !keepEdits) return { data: loaded, draft: draftOf(loaded), dirty: false };
      const base = current.data, draft = { ...current.draft };
      for (const field of ['tagline', 'about', 'phone', 'email', 'accentColor', 'primaryColor'] as const) {
        if (loaded[field] !== base[field]) draft[field] = loaded[field];
      }
      const known = new Map(base.photos.map((photo) => [photo.id, photo.alt])), now = new Map(loaded.photos.map((photo) => [photo.id, photo.alt]));
      const photos = [...draft.photos.filter((photo) => now.has(photo.id))
        .map((photo) => now.get(photo.id) !== known.get(photo.id) ? { ...photo, alt: now.get(photo.id)! } : photo),
      ...loaded.photos.filter((photo) => !known.has(photo.id))];
      return { data: loaded, draft: { ...draft, photos }, dirty: true };
    });
  }
  async function load() {
    setFailed(false);
    try {
      const result = await api.GET('/api/website');
      if (!result.response.ok || !result.data) throw new Error('The website settings request failed');
      show(parseResponse(websiteSettingsResponseSchema, result.data).data, true);
    } catch { setFailed(true); }
  }
  // Read again whenever the gym settings come from the server: a reload, a conflict, or this section's own save.
  useEffect(() => { void load(); }, [gym.epoch]);
  const adopt = (body: unknown, current: GymSettings): GymSettings => ({ ...current, revision: parseResponse(websiteSettingsResponseSchema, body).data.revision });
  /** `kind` says what the save changed: the text and colors, a photo, or the logo. */
  async function run(send: (revision: number, signal: AbortSignal) => Promise<Sent>, done: string, kind: 'content' | 'photo' | 'logo') {
    setBusy(true); setMessage(null);
    try {
      // The text and colors were read with this section's settings: a save from another section since (General's primary
      // color) is refused rather than overwritten. Uploads carry no values read earlier.
      const result = await gym.save(send, kind === 'content' && state ? { adopt, readAt: state.data.revision } : { adopt });
      if (result.status >= 300) {
        // A 403 here is an install that refuses uploads (a demo sandbox); the section itself needs settings access to show.
        setMessage({ text: text(result.status === 409 ? 'conflict' : result.status === 400 ? 'invalid' : result.status === 403 ? 'uploadsOff' : 'error'), error: true });
        if (result.status === 409 || result.status === 404) void load();
        return;
      }
      show(parseResponse(websiteSettingsResponseSchema, result.data).data, kind !== 'content'); setMessage({ text: text(done), error: false });
      // The logo and the primary color also show in General, which would otherwise save back what it read before.
      if (kind !== 'photo') { gym.reload(); void cache.invalidateQueries({ queryKey: bootstrapKey }); }
    } catch { setMessage({ text: text('error'), error: true }); }
    finally { setBusy(false); }
  }
  async function upload(file: File | undefined, kind: 'photo' | 'logo') {
    if (!file) return;
    let image;
    try { image = await prepareImage(file, kind); }
    catch { setMessage({ text: text('imageInvalid'), error: true }); return; }
    if (kind === 'photo') await run((revision, signal) => api.POST('/api/website/photos', { body: { revision, ...image, alt: '' }, signal }), 'photoAdded', 'photo');
    else await run((revision, signal) => api.POST('/api/website/logo', { body: { revision, ...image }, signal }), 'logoSaved', 'logo');
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state) return;
    const { draft } = state;
    await run((revision, signal) => api.PUT('/api/website', { body: { revision, ...draft,
      tagline: draft.tagline?.trim() || null, about: draft.about?.trim() || null, phone: draft.phone?.trim() || null, email: draft.email?.trim() || null }, signal }), 'saved', 'content');
  }
  if (!state) return failed
    ? <ErrorState message={text('error')} onRetry={() => void load()} retryLabel={text('reload')}/>
    : <LoadingState label={text('loading')}/>;
  const { data, draft } = state;
  const set = (change: Partial<Draft>) => { setState({ data, draft: { ...draft, ...change }, dirty: true }); setMessage(null); };
  const move = (index: number, by: number) => {
    const photos = [...draft.photos], [photo] = photos.splice(index, 1);
    photos.splice(index + by, 0, photo!); set({ photos });
  };
  return <div className="min-w-0 space-y-6">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <h2 className="text-lg font-semibold">{text('title')}</h2>
      <a href="/" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">{text('view')}</a>
    </div>
    <p className="text-sm text-muted-foreground">{text('help')}</p>
    {message && <p role={message.error ? 'alert' : 'status'} className="rounded-md border border-border bg-muted p-3 text-sm">{message.text}</p>}
    {failed && <ErrorState message={text('error')} onRetry={() => void load()} retryLabel={text('reload')}/>}
    <section className="space-y-3" aria-label={text('logo')}>
      <h3 className="text-base font-semibold">{text('logo')}</h3>
      {data.logo ? <img src={'/public/pages/logo/' + Math.max(data.revision, gym.settings?.revision ?? 0)} alt={text('logoPreview')} className="h-20 w-20 rounded-md border border-border object-contain"/>
        : <p className="text-sm text-muted-foreground">{text('noLogo')}</p>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Label className="grid min-w-0 flex-1 gap-2">{text(data.logo ? 'replaceLogo' : 'uploadLogo')}
          <Input type="file" accept="image/png,image/jpeg,image/webp" className="py-2" disabled={busy}
            onChange={(event) => { const input = event.currentTarget; void upload(input.files?.[0], 'logo').finally(() => { input.value = ''; }); }}/></Label>
        {data.logo && <Button type="button" variant="outline" disabled={busy}
          onClick={() => void run((revision, signal) => api.DELETE('/api/website/logo', { body: { revision }, signal }), 'logoRemoved', 'logo')}>{text('removeLogo')}</Button>}
      </div>
    </section>
    <form onSubmit={(event) => void save(event)} aria-label={text('content')} className="space-y-6 border-t border-border pt-6">
      <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <legend className="mb-4 text-base font-semibold">{text('content')}</legend>
        <div className="sm:col-span-2"><Field label={text('tagline')} help={text('taglineHelp')}>{(describedBy) =>
          <Input value={draft.tagline ?? ''} maxLength={160} aria-describedby={describedBy} onChange={(event) => set({ tagline: event.target.value })}/>}</Field></div>
        <div className="sm:col-span-2"><Field label={text('about')} help={text('aboutHelp')}>{(describedBy) =>
          <Textarea value={draft.about ?? ''} maxLength={5000} rows={6} aria-describedby={describedBy} onChange={(event) => set({ about: event.target.value })}/>}</Field></div>
        <Field label={text('phone')}>{() => <Input type="tel" autoComplete="tel" value={draft.phone ?? ''} maxLength={40} onChange={(event) => set({ phone: event.target.value })}/>}</Field>
        <Field label={text('email')}>{() => <Input type="email" autoComplete="email" value={draft.email ?? ''} maxLength={254} onChange={(event) => set({ email: event.target.value })}/>}</Field>
        <div className="grid min-w-0 gap-2">
          <Field label={text('primaryColor')} help={text('primaryColorHelp')}>{(describedBy) =>
            <Input type="color" value={draft.primaryColor ?? defaultPrimary} aria-describedby={describedBy} className="w-24 p-1"
              onChange={(event) => set({ primaryColor: event.target.value })}/>}</Field>
        </div>
        <div className="grid min-w-0 gap-2">
          <CheckboxField label={text('useAccent')} checked={draft.accentColor !== null}
            onChange={(event) => set({ accentColor: event.target.checked ? defaultAccent : null })}/>
          {draft.accentColor !== null && <Field label={text('accentColor')} help={text('accentColorHelp')}>{(describedBy) =>
            <Input type="color" value={draft.accentColor ?? defaultAccent} aria-describedby={describedBy} className="w-24 p-1"
              onChange={(event) => set({ accentColor: event.target.value })}/>}</Field>}
        </div>
      </fieldset>
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="mb-2 text-base font-semibold">{text('photos')}</legend>
        <p className="text-sm text-muted-foreground">{text('photosHelp', { max: String(maxPhotos) })}</p>
        {draft.photos.length ? <ol className="grid gap-4">
          {draft.photos.map((photo, index) => <li key={photo.id} className="grid min-w-0 gap-3 rounded-lg border border-border p-3 sm:grid-cols-[8rem_1fr]">
            <img src={'/website/photos/' + photo.id} alt="" className="aspect-[4/3] w-full rounded-md object-cover sm:w-32"/>
            <div className="grid min-w-0 gap-3">
              <Field label={text(index === 0 ? 'altFirst' : 'alt', { number: String(index + 1) })}>{() =>
                <Input value={photo.alt} maxLength={200} onChange={(event) => set({ photos: draft.photos.map((item) => item.id === photo.id ? { ...item, alt: event.target.value } : item) })}/>}</Field>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={index === 0} onClick={() => move(index, -1)}>{text('moveUp')}</Button>
                <Button type="button" variant="outline" disabled={index === draft.photos.length - 1} onClick={() => move(index, 1)}>{text('moveDown')}</Button>
                <Button type="button" variant="outline" onClick={() => set({ photos: draft.photos.filter((item) => item.id !== photo.id) })}>{text('removePhoto')}</Button>
              </div>
            </div>
          </li>)}
        </ol> : <p className="text-sm text-muted-foreground">{text('noPhotos')}</p>}
        {draft.photos.length !== data.photos.length && <p className="text-sm text-muted-foreground">{text('removedHelp')}</p>}
      </fieldset>
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="submit" disabled={busy}>{text('save')}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => { setMessage(null); gym.reload(); }}>{text('reload')}</Button>
      </div>
    </form>
    <div className="space-y-3 border-t border-border pt-6">
      <Label className="grid min-w-0 gap-2">{text('addPhoto')}
        <Input type="file" accept="image/png,image/jpeg,image/webp" className="py-2" disabled={busy || data.photos.length >= maxPhotos}
          onChange={(event) => { const input = event.currentTarget; void upload(input.files?.[0], 'photo').finally(() => { input.value = ''; }); }}/></Label>
      <p className="text-sm text-muted-foreground">{text(data.photos.length >= maxPhotos ? 'photosFull' : 'addPhotoHelp')}</p>
    </div>
  </div>;
}

// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { saveSmsIntegrationResponseSchema, type SmsIntegration } from '@plaingym/shared/contracts';
import { callingCode } from '@plaingym/shared/phone-countries';
import { api } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { parseResponse } from '../../../lib/response.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog, DialogActions, DialogCancel } from '../../../components/ui/dialog.js';
import { FormMessage } from '../../../components/ui/alert.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { Select } from '../../../components/ui/select.js';
import { failedText, integrationsOf, refusedText, text, type useIntegrations } from './state.js';
import { useGymSettings } from '../gym-settings.js';

const label = (key: string) => text('sms.' + key);
const removal = (key: string) => t('settings/integration-removal:' + key);
function Field({ name, type = 'text', value = '', required = true }: { name: string; type?: string; value?: string; required?: boolean }) {
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={'integrations-sms-' + name}>{label(name)}</Label>
    <Input id={'integrations-sms-' + name} name={name} type={type} required={required} defaultValue={value}
      maxLength={name === 'baseUrl' ? 2048 : type === 'password' ? 1024 : 100} autoComplete={type === 'password' ? 'new-password' : 'off'}/>
  </div>;
}
export function SmsIntegrationSection({ sms, editable, state }: { sms: SmsIntegration; editable: boolean; state: ReturnType<typeof useIntegrations> }) {
  const gym = useGymSettings();
  const [busy, setBusy] = useState(false), [open, setOpen] = useState(false), [confirming, setConfirming] = useState(false);
  const [authKind, setAuthKind] = useState(sms.authKind ?? 'token');
  const [senderKind, setSenderKind] = useState(sms.messagingServiceSid ? 'service' : 'from');
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const country = gym.settings?.address.country;
  const recognized = callingCode(country) !== null;
  const testNumberHint = !gym.settings || recognized ? null
    : senderKind === 'service' ? label('testHintServiceNoCountry')
      : country ? text('sms.testHintUnsupportedCountry', { country })
        : label('testHintNoCountry');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    const form = new FormData(event.currentTarget), field = (name: string) => String(form.get(name) ?? '').trim();
    try {
      const reply = await state.change((revision, signal) => api.PUT('/api/settings/integrations/sms', { signal, body: {
        revision, provider: 'twilio', accountSid: field('accountSid'), testTo: field('testTo'),
        auth: authKind === 'token' ? { token: field('token') } : { apiKey: field('apiKey'), secret: field('secret') },
        sender: senderKind === 'from' ? { from: field('from') } : { messagingServiceSid: field('messagingServiceSid') },
        ...(sms.baseUrl !== undefined && field('baseUrl') ? { baseUrl: field('baseUrl') } : {}),
      } }), data => {
        const value = parseResponse(saveSmsIntegrationResponseSchema, data).data;
        return { integrations: value.integrations, result: { test: value.test, failure: value.failure } };
      }, { timeoutMs: 75_000 });
      let failureKey = reply.result?.failure ? 'testFailed_' + reply.result.failure : 'testFailed';
      const baseUrl = field('baseUrl');
      if (reply.result?.failure === 'authentication' && baseUrl && new URL(baseUrl).origin !== 'https://api.twilio.com')
        failureKey = 'testFailed_authentication_custom';
      if (reply.result?.test === 'sent') { setOpen(false); setMessage({ kind: 'status', text: label('saved') }); }
      else setMessage({ kind: 'alert', text: reply.result?.test === 'failed' ? label(failureKey)
        : reply.reason === 'invalid_phone' ? label('invalidPhone') : reply.reason === 'twilio_only' ? label('twilioOnly') : refusedText(reply) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      const reply = await state.change((revision, signal) => api.DELETE('/api/settings/integrations/sms', { signal, body: { revision } }), integrationsOf);
      if (reply.status < 300) { setOpen(false); setMessage({ kind: 'status', text: label('removed') }); }
      else setMessage({ kind: 'alert', text: refusedText(reply) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(false); }
  }
  async function saveCap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    const smsDailyCap = Number(new FormData(event.currentTarget).get('smsDailyCap'));
    try {
      const result = await gym.save((revision, signal) => api.PATCH('/api/settings/integrations/sms/cap', { signal, body: { revision, smsDailyCap } }));
      setMessage({ kind: result.status < 300 ? 'status' : 'alert', text: result.status < 300 ? label('capSaved') : refusedText(result) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(false); }
  }
  return <section aria-label={label('title')} className="min-w-0 space-y-3">
    <h3 className="font-semibold">{label('title')}</h3>
    {sms.unreadable && <p role="alert" className="text-sm">{label('unreadable')}</p>}
    {/* A sandbox texts through the demo outbox (the page's intro says so), never through a saved provider. */}
    {!state.integrations?.sandbox && <p className="text-sm">{sms.configured ? text('sms.configured', { account: sms.accountSid ?? '', sender: sms.from ?? sms.messagingServiceSid ?? '' }) : label('notConfigured')}</p>}
    {sms.configured && <p className="text-sm text-muted-foreground">{label('stored')}</p>}
    <FormMessage message={message}/>
    {gym.settings && <form aria-label={label('capForm')} onSubmit={event => void saveCap(event)}>
        <fieldset disabled={busy || gym.failed} className="grid min-w-0 gap-3">
          <Label htmlFor="integrations-sms-cap">{label('dailyCap')}</Label>
          {/* Starts over only when the settings are read from the server again, never after a save from this page. */}
          <Input key={gym.epoch} id="integrations-sms-cap" name="smsDailyCap" type="number" min={1} max={100000} step={1}
            required defaultValue={gym.settings.smsDailyCap} aria-describedby="integrations-sms-cap-help"/>
          <p id="integrations-sms-cap-help" className="text-sm text-muted-foreground">{label('capHelp')}</p>
          <div><Button type="submit">{label('saveCap')}</Button></div>
        </fieldset>
      </form>}
    {editable && <>
      <p className="text-sm text-muted-foreground">{label('hint')}</p>
      <div className="flex flex-col items-start gap-3 sm:flex-row">
        {!open && <Button variant="outline" onClick={() => { setOpen(true); setMessage(null); }}>{label(sms.configured ? 'change' : 'connect')}</Button>}
        {(sms.configured || sms.unreadable) && <Button variant="outline" disabled={busy} onClick={() => { setMessage(null); setConfirming(true); }}>{label('remove')}</Button>}
      </div>
      {confirming && <Dialog title={removal('sms.title')} closeLabel={removal('close')} onClose={() => setConfirming(false)}>
        <div className="space-y-4">
          <p>{removal('sms.body')}</p>
          <p>{removal('sms.secret')}</p>
        </div>
        <DialogActions>
          <Button variant="destructive" onClick={() => { setConfirming(false); void remove(); }}>{label('remove')}</Button>
          <DialogCancel variant="outline">{removal('cancel')}</DialogCancel>
        </DialogActions>
      </Dialog>}
      {open && <form aria-label={label('form')} onSubmit={event => void save(event)}>
        <fieldset disabled={busy} className="grid min-w-0 gap-4">
          <Field name="accountSid" value={sms.accountSid ?? ''}/>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="integrations-sms-authKind">{label('authKind')}</Label>
            <Select id="integrations-sms-authKind" value={authKind} onChange={event => setAuthKind(event.target.value as typeof authKind)}>
              <option value="token">{label('token')}</option><option value="apiKey">{label('apiKeyAuth')}</option>
            </Select>
          </div>
          {authKind === 'token' ? <Field key="token" name="token" type="password"/> : <><Field name="apiKey"/><Field key="secret" name="secret" type="password"/></>}
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="integrations-sms-senderKind">{label('senderKind')}</Label>
            <Select id="integrations-sms-senderKind" value={senderKind} onChange={event => setSenderKind(event.target.value)}>
              <option value="from">{label('from')}</option><option value="service">{label('messagingServiceSid')}</option>
            </Select>
          </div>
          {senderKind === 'from' ? <Field key="from" name="from" type="tel" value={sms.from ?? ''}/>
            : <Field key="service" name="messagingServiceSid" value={sms.messagingServiceSid ?? ''}/>}
          {sms.baseUrl !== undefined && <Field name="baseUrl" type="url" value={sms.baseUrl} required={false}/>}
          <Field name="testTo" type="tel"/>
          <p className="text-sm text-muted-foreground">{label('testHint')}</p>
          {testNumberHint && <p className="text-sm text-muted-foreground">{testNumberHint}</p>}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="submit">{label(busy ? 'saving' : 'save')}</Button>
            <Button variant="outline" onClick={() => setOpen(false)}>{label('cancel')}</Button>
          </div>
        </fieldset>
      </form>}
    </>}
  </section>;
}

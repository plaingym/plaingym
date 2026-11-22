// SPDX-License-Identifier: AGPL-3.0-only
import { smtpPresets } from '../../../lib/integration-setup.js';
import { parseResponse } from '../../../lib/response.js';
import { useState, type FormEvent } from 'react';
import { saveEmailIntegrationResponseSchema, type EmailIntegration, type SignInMethods } from '@plaingym/shared/contracts';
import { api } from '../../../lib/api.js';
import { t } from '../../../lib/i18n.js';
import { Button } from '../../../components/ui/button.js';
import { Dialog, DialogActions, DialogCancel } from '../../../components/ui/dialog.js';
import { FormMessage } from '../../../components/ui/alert.js';
import { Input } from '../../../components/ui/input.js';
import { Label } from '../../../components/ui/label.js';
import { CheckboxField, Select } from '../../../components/ui/select.js';
import { SmtpPortHint } from '../../setup/smtp-port-hint.js';
import { failedText, integrationsOf, refusedText, text, type useIntegrations } from './state.js';

const label = (key: string) => text('email.' + key);
const removal = (key: string) => t('settings/integration-removal:' + key);
export const methods = (signIn: SignInMethods) =>
  label('methods_' + (signIn.magicLink && signIn.password ? 'both' : signIn.magicLink ? 'magicLink' : signIn.password ? 'password' : 'none'));
const same = (a: SignInMethods, b: SignInMethods) => a.magicLink === b.magicLink && a.password === b.password;
type Message = { kind: 'status' | 'alert'; text: string };

function Field({ name, type = 'text', value, required = true, onChange, hint }: { name: string; type?: string; value?: string; required?: boolean; onChange?: (value: string) => void; hint?: string }) {
  const id = 'integrations-email-' + name, hintId = id + '-hint';
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={id}>{label(name)}</Label>
    <Input id={id} name={name} type={type} required={required} autoComplete={type === 'password' ? 'new-password' : 'off'} aria-describedby={hint ? hintId : undefined}
      {...(value === undefined ? {} : { value, onChange: (event) => onChange?.(event.target.value) })}/>
    {hint && <p id={hintId} className="text-sm text-muted-foreground">{hint}</p>}
  </div>;
}
/**
 * The gym's sending service: shown without its password, replaced only after a test email is accepted, or removed. Only
 * shown when `editable` is false, where the install's operator manages it.
 */
export function EmailIntegrationSection({ email, editable, state }: { email: EmailIntegration; editable: boolean; state: ReturnType<typeof useIntegrations> }) {
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null), [message, setMessage] = useState<Message | null>(null);
  const [host, setHost] = useState(email.source === 'gym' ? email.host ?? '' : ''), [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const saveChangesSignIn = !same(email.signIn, email.signInAfterSave);
  const removeChangesSignIn = email.signInAfterRemove !== null && !same(email.signIn, email.signInAfterRemove);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null);
    const form = new FormData(event.currentTarget), field = (name: string) => String(form.get(name) ?? '');
    setBusy('save');
    try {
      const reply = await state.change((revision, signal) => api.PUT('/api/settings/integrations/email', { signal, body: { revision, host: field('host').trim(),
        port: Number(field('port')), secure: form.has('secure'), username: field('username'), password: field('password'),
        from: field('from'), testTo: field('testTo') } }), (data) => {
        const parsed = parseResponse(saveEmailIntegrationResponseSchema, data).data;
        return { integrations: parsed.integrations, result: { test: parsed.test, failure: parsed.failure } };
      });
      if (reply.result?.test === 'sent') { setMessage({ kind: 'status', text: label('saved') }); setOpen(false); }
      else if (reply.result?.test === 'failed') {
        const { failure } = reply.result;
        setMessage({ kind: 'alert', text: label(failure ? 'testFailed_' + failure : 'testFailed') });
      }
      else setMessage({ kind: 'alert', text: reply.reason === 'port_not_allowed' ? label('portNotAllowed') : refusedText(reply) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(null); }
  }
  async function remove() {
    if (busy !== null) return;
    setMessage(null); setBusy('remove');
    try {
      const reply = await state.change((revision, signal) => api.DELETE('/api/settings/integrations/email', { signal, body: { revision } }), integrationsOf);
      if (reply.status < 300) { setMessage({ kind: 'status', text: label('removed') }); setHost(''); }
      else setMessage({ kind: 'alert', text: reply.reason === 'only_sign_in' ? label('onlySignIn') : reply.reason === 'not_configured' ? label('notConfigured')
        : refusedText(reply) });
    } catch (error) { setMessage({ kind: 'alert', text: failedText(error) }); }
    finally { setBusy(null); }
  }
  return <div className="grid min-w-0 gap-4">
    <h3 className="text-base font-semibold">{label('title')}</h3>
    {email.unreadable && <p role="alert" className="wrap-anywhere text-sm">{label('unreadable')}</p>}
    <p className="text-sm [overflow-wrap:anywhere]">{email.source === 'gym'
      ? text('email.sourceGym', { host: email.host ?? '', port: email.port ?? '', security: label('security_' + (email.security ?? 'starttls')), from: email.from ?? '' })
      : label(email.source === 'install' ? 'sourceInstall' : 'sourceNone')}</p>
    <p className="text-sm text-muted-foreground">{text('email.signIn', { methods: methods(email.signIn) })}</p>
    {editable && email.source === 'gym' && email.googleConfigured && <p className="text-sm text-muted-foreground">{label('googleRemovalRule')}</p>}
    <FormMessage message={message}/>
    {editable && <>
      {(email.source === 'gym' || email.unreadable) && <div className="grid min-w-0 gap-2">
        {email.removeBlocked ? <p className="text-sm text-muted-foreground">{label('onlySignIn')}</p>
          : removeChangesSignIn && <p className="text-sm">{text('email.signInChangesOnRemove', { methods: methods(email.signInAfterRemove!) })}</p>}
        <div><Button type="button" variant="outline" disabled={busy !== null || email.removeBlocked} onClick={() => { setMessage(null); setConfirming(true); }}>
          {label(busy === 'remove' ? 'removing' : email.signInAfterRemove?.magicLink ? 'remove' : 'removeNone')}</Button></div>
      </div>}
      {confirming && !email.removeBlocked && <Dialog title={removal('email.title')} closeLabel={removal('close')} onClose={() => setConfirming(false)}>
        <div className="space-y-4">
          <p>{removal(email.signInAfterRemove?.magicLink ? 'email.install' : 'email.none')}</p>
          {removeChangesSignIn && <p>{text('email.signInChangesOnRemove', { methods: methods(email.signInAfterRemove!) })}</p>}
          <p>{removal('email.secret')}</p>
        </div>
        <DialogActions>
          <Button variant="destructive" onClick={() => { setConfirming(false); void remove(); }}>
            {label(busy === 'remove' ? 'removing' : email.signInAfterRemove?.magicLink ? 'remove' : 'removeNone')}</Button>
          <DialogCancel variant="outline">{removal('cancel')}</DialogCancel>
        </DialogActions>
      </Dialog>}
      {!open ? <div><Button type="button" variant="outline" onClick={() => { setMessage(null); setOpen(true); }}>{label(email.source === 'gym' ? 'change' : 'replace')}</Button></div>
      : <form onSubmit={(event) => void save(event)} aria-label={label(email.source === 'gym' ? 'change' : 'replace')}>
        <fieldset disabled={busy !== null} className="grid min-w-0 gap-4">
          <p className="text-sm text-muted-foreground">{label('hint')}</p>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="integrations-email-preset">{label('preset')}</Label>
            <Select id="integrations-email-preset" defaultValue="" onChange={(event) => { if (event.target.value) setHost(event.target.value); }}>
              <option value="">{label('custom')}</option>
              {smtpPresets.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
            </Select>
          </div>
          <Field name="host" value={host} onChange={setHost} hint={label('hostHint')}/>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="integrations-email-port">{label('port')}</Label>
            <Input id="integrations-email-port" name="port" type="number" inputMode="numeric" min={1} max={65535} required defaultValue={email.source === 'gym' ? email.port ?? 587 : 587}/>
          </div>
          <CheckboxField name="secure" label={label('secure')} defaultChecked={email.source === 'gym' && email.security === 'tls'}/>
          <SmtpPortHint text={(kind) => label('portMismatch_' + kind)}/>
          <Field name="username"/>
          <Field name="password" type="password"/>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="integrations-email-from">{label('from')}</Label>
            <Input id="integrations-email-from" name="from" type="email" required defaultValue={email.source === 'gym' ? email.from ?? '' : ''} aria-describedby="integrations-email-from-hint"/>
            <p id="integrations-email-from-hint" className="text-sm text-muted-foreground">{label('fromHint')}</p>
          </div>
          <Field name="testTo" type="email"/>
          {saveChangesSignIn && <>
            <p role="note" className="rounded-md border border-border p-3 text-sm">{text('email.signInChangesOnSave', { methods: methods(email.signInAfterSave) })}</p>
            <CheckboxField required label={label('confirmSignIn')}/>
          </>}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button type="submit">{label(busy === 'save' ? 'saving' : 'save')}</Button>
          </div>
        </fieldset>
      </form>}
    </>}
  </div>;
}

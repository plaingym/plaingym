// SPDX-License-Identifier: AGPL-3.0-only
import { parseResponse } from '../../lib/response.js';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { qrDataUrl } from '../../lib/qr.js';
import { kioskDeviceListResponseSchema, kioskDeviceResponseSchema, registerKioskDeviceResponseSchema,
  type KioskDeviceListResponse } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { instantLabel } from '../../lib/instant.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { TableContainer } from '../../components/ui/table.js';

const pageSize = 20;
export function KioskDevicesSettings() {
  const [page, setPage] = useState<KioskDeviceListResponse | null>(null);
  const [token, setToken] = useState<{ deviceId: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(0);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(0), 3_000);
    return () => clearTimeout(timer);
  }, [copied]);
  // The link and its code exist only in memory while the token is shown; nothing is stored.
  const setupLink = token ? window.location.origin + '/kiosk#token=' + encodeURIComponent(token.value) : '';
  const qr = useMemo(() => {
    if (!setupLink) return '';
    try { return qrDataUrl(setupLink); } catch { return ''; }
  }, [setupLink]);
  // Clearing the token also resets the reveal and copy state, so the next token never starts revealed.
  function clearToken() { setToken(null); setShowToken(false); setCopied(0); setCopyFailed(false); }
  async function copyLink() {
    try { await navigator.clipboard.writeText(setupLink); setCopied((value) => value + 1); setCopyFailed(false); }
    catch { setCopied(0); setCopyFailed(true); }
  }
  useEffect(() => {
    let active = true;
    setBusy(true); setMessage(''); setPage(null);
    void api.GET('/api/kiosk/devices', { params: { query: { limit: pageSize, offset } } }).then((result) => {
      if (!result.response.ok) throw new Error();
      const next = parseResponse(kioskDeviceListResponseSchema, result.data);
      if (active) setPage(next);
    }).catch(() => { if (active) setMessage(t('kiosk/devices:error')); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [offset, reload]);
  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.POST('/api/kiosk/devices', { body: { name } });
      if (!result.response.ok) throw new Error();
      const data = parseResponse(registerKioskDeviceResponseSchema, result.data).data;
      setToken({ deviceId: data.device.id, value: data.token });
      form.reset(); setOffset(0); setReload((value) => value + 1);
    } catch { setMessage(t('kiosk/devices:error')); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setMessage('');
    try {
      const result = await api.POST('/api/kiosk/devices/{id}/revoke', { params: { path: { id } } });
      if (!result.response.ok) throw new Error();
      const device = parseResponse(kioskDeviceResponseSchema, result.data).data;
      setPage((previous) => previous && ({ ...previous, data: previous.data.map((row) => row.id === id ? device : row) }));
      if (token?.deviceId === id) clearToken();
    } catch { setMessage(t('kiosk/devices:error')); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label={t('kiosk/devices:title')}>
    <h2 className="text-lg font-semibold">{t('kiosk/devices:title')}</h2>
    <p>{t('kiosk/devices:help')}</p>
    {message && <Alert variant="error" focusOnReveal>{message}</Alert>}
    {copyFailed && <Alert variant="error" focusOnReveal>{t('kiosk/devices:copyFailed')}</Alert>}
    {token && <Alert>
      <p>{t('kiosk/devices:setupOnce')}</p>
      {qr && <img src={qr} alt={t('kiosk/devices:qrAlt')} className="my-2 h-auto w-full max-w-64 bg-white"/>}
      {!qr && <p role="status">{t('kiosk/devices:qrFailed')}</p>}
      <code className="my-2 block break-all select-all">{setupLink}</code>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void copyLink()}>{copied ? t('kiosk/devices:copied') : t('kiosk/devices:copy')}</Button>
        <Button variant="outline" aria-expanded={showToken} onClick={() => setShowToken((value) => !value)}>{t(showToken ? 'kiosk/devices:hideToken' : 'kiosk/devices:showToken')}</Button>
        <Button variant="outline" onClick={clearToken}>{t('kiosk/devices:dismiss')}</Button>
      </div>
      {showToken && <><p className="mt-2">{t('kiosk/devices:tokenHelp')}</p>
        <code className="my-2 block break-all select-all">{token.value}</code></>}
    </Alert>}
    <form onSubmit={(event) => void register(event)} className="flex flex-wrap items-end gap-3">
      <div className="space-y-2"><Label htmlFor="kiosk-device-name">{t('kiosk/devices:name')}</Label>
        <Input id="kiosk-device-name" name="name" required disabled={busy || token !== null}/></div>
      <Button type="submit" disabled={busy || token !== null}>{t('kiosk/devices:register')}</Button>
    </form>
    <Button variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>{t('kiosk/devices:refresh')}</Button>
    {busy && <p role="status">{t('kiosk/devices:loading')}</p>}
    {page && <TableContainer label={t('kiosk/devices:title')}><table className="w-full text-left">
      <caption className="sr-only">{t('kiosk/devices:title')}</caption>
      <thead><tr>{['name', 'created', 'lastSeen', 'status', 'actions'].map((key) =>
        <th key={key} scope="col" className="p-2">{t('kiosk/devices:' + key)}</th>)}</tr></thead>
      <tbody>{page.data.map((device) => <tr key={device.id}>
        <td className="p-2">{device.name}</td>
        <td className="p-2"><time dateTime={device.createdAt}>{instantLabel(device.createdAt)}</time></td>
        <td className="p-2">{device.lastSeenAt
          ? <time dateTime={device.lastSeenAt}>{instantLabel(device.lastSeenAt)}</time> : t('kiosk/devices:never')}</td>
        <td className="p-2">{t(device.revokedAt ? 'kiosk/devices:revoked' : 'kiosk/devices:active')}</td>
        <td className="p-2"><Button variant="outline" disabled={busy || device.revokedAt !== null}
          aria-label={t('kiosk/devices:revokeNamed', { name: device.name })} onClick={() => void revoke(device.id)}>
          {t('kiosk/devices:revoke')}</Button></td>
      </tr>)}</tbody>
    </table>{page.data.length === 0 && <p className="p-2">{t('kiosk/devices:empty')}</p>}</TableContainer>}
    <Pager offset={offset} total={page?.pagination.total ?? 0} limit={pageSize} disabled={busy} onChange={setOffset} previousLabel={t('kiosk/devices:previous')} nextLabel={t('kiosk/devices:next')}/>
  </section>;
}

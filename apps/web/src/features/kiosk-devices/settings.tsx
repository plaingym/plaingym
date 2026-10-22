// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { kioskDeviceListResponseSchema, kioskDeviceResponseSchema, registerKioskDeviceResponseSchema,
  type KioskDeviceListResponse } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';

const pageSize = 20;
export function KioskDevicesSettings() {
  const [page, setPage] = useState<KioskDeviceListResponse | null>(null);
  const [token, setToken] = useState<{ deviceId: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true); setMessage(''); setPage(null);
    void api.GET('/api/kiosk/devices', { params: { query: { limit: pageSize, offset } } }).then((result) => {
      if (!result.response.ok) throw new Error();
      const next = kioskDeviceListResponseSchema.parse(result.data);
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
      const data = registerKioskDeviceResponseSchema.parse(result.data).data;
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
      const device = kioskDeviceResponseSchema.parse(result.data).data;
      setPage((previous) => previous && ({ ...previous, data: previous.data.map((row) => row.id === id ? device : row) }));
      if (token?.deviceId === id) setToken(null);
    } catch { setMessage(t('kiosk/devices:error')); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4" aria-label={t('kiosk/devices:title')}>
    <h2 className="text-lg font-semibold">{t('kiosk/devices:title')}</h2>
    <p>{t('kiosk/devices:help')}</p>
    {message && <Alert>{message}</Alert>}
    {token && <Alert>
      <p>{t('kiosk/devices:tokenOnce')}</p>
      <code className="my-2 block break-all select-all">{token.value}</code>
      <Button variant="outline" onClick={() => setToken(null)}>{t('kiosk/devices:dismiss')}</Button>
    </Alert>}
    <form onSubmit={(event) => void register(event)} className="flex flex-wrap items-end gap-3">
      <div className="space-y-2"><Label htmlFor="kiosk-device-name">{t('kiosk/devices:name')}</Label>
        <Input id="kiosk-device-name" name="name" required disabled={busy || token !== null}/></div>
      <Button type="submit" disabled={busy || token !== null}>{t('kiosk/devices:register')}</Button>
    </form>
    <Button variant="outline" disabled={busy} onClick={() => setReload((value) => value + 1)}>{t('kiosk/devices:refresh')}</Button>
    {busy && <p role="status">{t('kiosk/devices:loading')}</p>}
    {page && <div className="overflow-x-auto"><table className="w-full text-left">
      <caption className="sr-only">{t('kiosk/devices:title')}</caption>
      <thead><tr>{['name', 'created', 'lastSeen', 'status', 'actions'].map((key) =>
        <th key={key} scope="col" className="p-2">{t('kiosk/devices:' + key)}</th>)}</tr></thead>
      <tbody>{page.data.map((device) => <tr key={device.id}>
        <td className="p-2">{device.name}</td>
        <td className="p-2"><time dateTime={device.createdAt}>{new Date(device.createdAt).toLocaleString()}</time></td>
        <td className="p-2">{device.lastSeenAt
          ? <time dateTime={device.lastSeenAt}>{new Date(device.lastSeenAt).toLocaleString()}</time> : t('kiosk/devices:never')}</td>
        <td className="p-2">{t(device.revokedAt ? 'kiosk/devices:revoked' : 'kiosk/devices:active')}</td>
        <td className="p-2"><Button variant="outline" disabled={busy || device.revokedAt !== null}
          aria-label={t('kiosk/devices:revokeNamed', { name: device.name })} onClick={() => void revoke(device.id)}>
          {t('kiosk/devices:revoke')}</Button></td>
      </tr>)}</tbody>
    </table>{page.data.length === 0 && <p>{t('kiosk/devices:empty')}</p>}</div>}
    <div className="flex gap-2">
      <Button variant="outline" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>{t('kiosk/devices:previous')}</Button>
      <Button variant="outline" disabled={busy || !page || offset + pageSize >= page.pagination.total} onClick={() => setOffset(offset + pageSize)}>{t('kiosk/devices:next')}</Button>
    </div>
  </section>;
}

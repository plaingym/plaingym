// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { healthContracts, healthResponseSchema, healthTileIds, type HealthTile } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';

const label = (key: string) => t('health/status:' + key);
function detailValue(key: string, value: unknown) {
  if (value === null) return label('unknown');
  if (typeof value === 'boolean') return label(value ? 'yes' : 'no');
  if (typeof value === 'number') return value.toLocaleString();
  if (key === 'result') return label('result.' + String(value));
  if (key.endsWith('Url') && typeof value === 'string') return <a href={value} className="underline" target="_blank" rel="noreferrer">{label('field.' + key)}</a>;
  return String(value);
}
/** Every tile uses the same presentation, including tiles supplied by other providers. */
export function HealthTiles({ tiles }: { tiles: readonly HealthTile[] }) {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{healthTileIds.map((id) => {
    const tile = byId.get(id);
    if (!tile) return null;
    return <Card key={id} aria-labelledby={'health-' + id} className={tile.status === 'error' ? 'border-destructive' : ''}>
      <h2 id={'health-' + id} className="text-lg font-semibold">{label('tile.' + id)}</h2>
      <p className="mt-2 font-medium">{label('status.' + tile.status)}</p>
      <p className="mt-2 text-sm">{tile.message}</p>
      {tile.details && <dl className="mt-4 space-y-2 text-sm">{Object.entries(tile.details).filter(([key]) => key !== 'keyReminder').map(([key, value]) =>
        <div key={key} className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{label('field.' + key)}</dt><dd className="break-all">{detailValue(key, value)}</dd></div>)}</dl>}
      {tile.details && 'keyReminder' in tile.details && tile.details.keyReminder && <p className="mt-4 text-sm font-medium">{label('keyReminder')}</p>}
      {tile.checkedAt && <p className="mt-4 text-xs text-muted-foreground">{label('checkedAt')}: <time dateTime={tile.checkedAt}>{new Date(tile.checkedAt).toLocaleString()}</time></p>}
    </Card>;
  })}</div>;
}
function HealthPanel({ gymId }: { gymId: string }) {
  const query = useQuery({ queryKey: ['health', gymId], queryFn: async ({ signal }) => {
    const result = await api.GET(healthContracts.get.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Health check failed');
    return healthResponseSchema.parse(result.data).data;
  }, refetchInterval: 60_000 });
  return <main className="mx-auto max-w-7xl space-y-6 p-6">
    <div className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold">{label('title')}</h1><Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{label('refresh')}</Button></div>
    {query.isPending ? <p role="status">{label('loading')}</p> : query.isError ? <Alert>{label('loadFailed')}</Alert> : <HealthTiles tiles={query.data.tiles}/>}
  </main>;
}
export function HealthPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{label('loading')}</p>;
  if (bootstrap.isError) return <Alert>{label('loadFailed')}</Alert>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'settings.manage')) return <Alert>{label('noAccess')}</Alert>;
  return <HealthPanel gymId={bootstrap.data.gym.id}/>;
}

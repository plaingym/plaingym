// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { healthContracts, healthTileIds, sharedDiskVolume, type HealthTile } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { formatCount } from '../../lib/count.js';
import { instantLabel } from '../../lib/instant.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card } from '../../components/ui/card.js';
import { Page, PageHeader } from '../../components/ui/page.js';
import { ChargeFailures } from './charge-failures.js';
import { EffectFailures } from './effect-failures.js';
import { BackupActions } from './backups.js';
import { FailedJobsActions, parseHealthResponse, type ShownHealthTile } from './failed-jobs.js';

const label = (key: string) => t('health/status:' + key);
/** A size in bytes in the largest unit that keeps it at 1 or more (decimal units, as disks are sold). */
export function bytesLabel(bytes: number) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes, unit = 0;
  // 999.5 and up would round to "1,000" in this unit, so it moves to the next one.
  while (value >= 999.5 && unit < units.length - 1) { value /= 1000; unit++; }
  return value.toLocaleString('en', { maximumFractionDigits: unit && value < 100 ? 1 : 0 }) + ' ' + units[unit];
}
/** A duration in its largest whole units, rounded down: "48 minutes", "3 hours 5 minutes", "2 days". */
export function durationLabel(seconds: number) {
  const unit = (count: number, singular: string, plural: string) => count === 1 ? label('duration.' + singular)
    : t('health/status:duration.' + plural, { count: formatCount(count) });
  if (seconds < 60) return label('duration.lessThanMinute');
  const minutes = Math.floor(seconds / 60);
  if (seconds < 3600) return unit(minutes, 'minute', 'minutes');
  if (seconds < 86_400) {
    const hours = unit(Math.floor(seconds / 3600), 'hour', 'hours'), rest = minutes % 60;
    return rest ? hours + ' ' + unit(rest, 'minute', 'minutes') : hours;
  }
  return unit(Math.floor(seconds / 86_400), 'day', 'days');
}
function detailValue(key: string, value: unknown, timezone?: string) {
  if (value === null) return label('unknown');
  if (typeof value === 'boolean') return label(value ? 'yes' : 'no');
  if (typeof value === 'number') return key.endsWith('Bytes') ? bytesLabel(value) : key.endsWith('Seconds') ? durationLabel(value) : formatCount(value);
  if (key === 'result') return label('result.' + String(value));
  if (key === 'lastTestResult') return label('sms.test.' + String(value));
  if (key.endsWith('At') && typeof value === 'string') return <time dateTime={value}>{instantLabel(value, timezone)}</time>;
  if (key.endsWith('Url') && typeof value === 'string') return <a href={value} className="inline-flex min-h-11 min-w-11 items-center underline" target="_blank" rel="noreferrer">{label('field.' + key)}</a>;
  return String(value);
}
/**
 * The detail rows a tile shows. The Automatic updates tile labels its versions for what the attempt did (an up-to-date
 * check names only the running version, a rollback the version it tried) and leaves out a version the attempt has none of.
 */
function detailRows(tile: ShownHealthTile): [key: string, label: string, value: unknown][] {
  if (!tile.details) return [];
  if (tile.id === 'sms') return Object.entries(tile.details).map(([key, value]) => [key, label('sms.field.' + key), value]);
  if (tile.id === 'disk') {
    if (tile.details.sameFilesystem) {
      // A shared volume shows the lower free figure alongside that path's total.
      const shared = sharedDiskVolume(tile.details);
      return [
        ['sharedTotalBytes', label('field.sharedTotalBytes'), shared.totalBytes],
        ['sharedAvailableBytes', label('field.sharedAvailableBytes'), shared.availableBytes],
      ];
    }
    return [
      ['uploadsTotalBytes', label('field.uploadsTotalBytes'), tile.details.uploads.totalBytes],
      ['uploadsAvailableBytes', label('field.uploadsAvailableBytes'), tile.details.uploads.availableBytes],
      ...(tile.details.backupStaging ? [
        ['backupStagingTotalBytes', label('field.backupStagingTotalBytes'), tile.details.backupStaging.totalBytes],
        ['backupStagingAvailableBytes', label('field.backupStagingAvailableBytes'), tile.details.backupStaging.availableBytes],
      ] as [string, string, unknown][] : []),
    ];
  }
  const versions = tile.id === 'automatic_updates' ? tile.details : null;
  // A null oldest failure means no failed jobs remain, not an unknown time, so the row is left out. The failed jobs
  // version is an opaque digest for Acknowledge failed jobs, not something to read.
  return Object.entries(tile.details).filter(([key, value]) => key !== 'keyReminder' && key !== 'noneUnderCurrentKey' && key !== 'pruningHeld' && key !== 'damagedGuardSnapshot' && key !== 'missingGuardSnapshot'
    // The tile's message already names a destination failure's cause.
    && key !== 'destinationFailure'
    && !(tile.id === 'failed_jobs' && key === 'failedVersion')
    && !(versions && (key === 'fromVersion' || key === 'toVersion') && value === null)
    && !(tile.id === 'failed_jobs' && key === 'oldestFailureAt' && value === null))
    .map(([key, value]) => [key, label(versions && (key === 'fromVersion' || key === 'toVersion') ? `field.${key}.${versions.result}` : 'field.' + key),
      tile.id === 'last_backup' && key === 'pruningStopped' ? tile.details!.pruningStopped || tile.details!.pruningHeld : value]);
}
/** Every tile uses the same presentation, including tiles supplied by other providers. */
export function HealthTiles({ tiles, extras = {}, timezone }: { tiles: readonly ShownHealthTile[]; extras?: Partial<Record<HealthTile['id'], ReactNode>>; timezone?: string }) {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{healthTileIds.map((id) => {
    const tile = byId.get(id);
    if (!tile) return null;
    return <Card key={id} aria-labelledby={'health-' + id} className={tile.status === 'error' ? 'border-destructive' : ''}>
      <h2 id={'health-' + id} className="text-lg font-semibold">{label('tile.' + id)}</h2>
      <p className="mt-2 font-medium">{label('status.' + tile.status)}</p>
      <p className="mt-2 text-sm">{tile.message}</p>
      {tile.details && <dl className="mt-4 space-y-2 text-sm">{detailRows(tile).map(([key, name, value]) =>
        <div key={key} className="flex flex-wrap justify-between gap-2"><dt className="text-muted-foreground">{name}</dt><dd className="break-all">{detailValue(key, value, timezone)}</dd></div>)}</dl>}
      {tile.details && 'keyReminder' in tile.details && tile.details.keyReminder && <p className="mt-4 text-sm font-medium">{label('keyReminder')}</p>}
      {tile.id === 'last_backup' && tile.details?.damagedGuardSnapshot && <p className="mt-4 text-sm font-medium">{t('health/status:backupDamagedGuard', { snapshot: tile.details.damagedGuardSnapshot })}</p>}
      {tile.id === 'last_backup' && tile.details?.missingGuardSnapshot && <p className="mt-4 text-sm font-medium">{t('health/status:backupMissingGuard', { snapshot: tile.details.missingGuardSnapshot })}</p>}
      {extras[id]}
      {tile.checkedAt && <p className="mt-4 text-xs text-muted-foreground">{label('checkedAt')}: <time dateTime={tile.checkedAt}>{instantLabel(tile.checkedAt, timezone)}</time></p>}
    </Card>;
  })}</div>;
}
function HealthPanel({ gymId, owner, timezone }: { gymId: string; owner: boolean; timezone: string }) {
  // Refresh reads the tiles and the charge failure list together: both sit under this key.
  const cache = useQueryClient();
  const query = useQuery({ queryKey: ['health', gymId], queryFn: async ({ signal }) => {
    const result = await api.GET(healthContracts.get.path, { signal, cache: 'no-store' });
    if (!result.response.ok) throw new Error('Health check failed');
    return parseHealthResponse(result.data);
  }, refetchInterval: 60_000 });
  // Inside the admin shell's main, like every other admin page: one main landmark and the same header.
  return <Page>
    <PageHeader title={label('title')} actions={<Button variant="outline" disabled={query.isFetching} onClick={() => void cache.invalidateQueries({ queryKey: ['health', gymId] })}>{label('refresh')}</Button>}/>
    {query.isPending ? <p role="status" data-loading>{label('loading')}</p> : query.isError ? <Alert variant="error">{label('loadFailed')}</Alert> : <HealthTiles tiles={query.data.tiles} timezone={timezone} extras={{
      last_backup: <BackupActions gymId={gymId} owner={owner}/>,
      failed_jobs: <FailedJobsActions gymId={gymId} tile={query.data.tiles.find(tile => tile.id === 'failed_jobs')}/>,
      invoice_effects: <EffectFailures gymId={gymId} timezone={timezone} reporting={query.data.tiles.some(tile => tile.id === 'invoice_effects' && tile.status === 'error')}/>,
      last_charge_run: <ChargeFailures gymId={gymId} reporting={query.data.tiles.some((tile) => tile.id === 'last_charge_run' && tile.status === 'error')}/> }}/>}
  </Page>;
}
export function HealthPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status" data-loading>{label('loading')}</p>;
  if (bootstrap.isError) return <Alert variant="error">{label('loadFailed')}</Alert>;
  if (!bootstrap.data.session || !canStaff(bootstrap.data.session.roles, 'settings.manage')) return <Alert variant="error">{label('noAccess')}</Alert>;
  return <HealthPanel gymId={bootstrap.data.gym.id} owner={canStaff(bootstrap.data.session.roles, 'integrations.manage')}
    timezone={bootstrap.data.gym.timezone}/>;
}

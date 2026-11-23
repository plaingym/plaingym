// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { acknowledgeFailedJobsResponseSchema, healthContracts, healthResponseSchema, type HealthTile } from '@plaingym/shared/contracts';
import { api } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { parseResponse } from '../../lib/response.js';
import { Alert } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';

const label = (key: string) => t('health/status:' + key);

type HealthData = ReturnType<typeof healthResponseSchema.parse>['data'];
type FailedJobsTile = Extract<HealthTile, { id: 'failed_jobs' }>;
type FailedJobsDetails = NonNullable<FailedJobsTile['details']>;
/**
 * A tile as the page shows it. A server from before failed jobs could be acknowledged (an older release, say after a
 * rollback) sends the Background jobs tile without `failedVersion`; it shows normally, with no Acknowledge action.
 */
export type ShownHealthTile = Exclude<HealthTile, FailedJobsTile>
  | (Omit<FailedJobsTile, 'details'> & { details: (Omit<FailedJobsDetails, 'failedVersion'> & { failedVersion?: string }) | null });
/** Stands in for the missing version only while the rest of the response is validated; it never reaches a tile. */
const missingVersion = 'missing';
/**
 * Reads `GET /api/health` as `parseResponse` does, every field as strict as the shared contract, except that the
 * Background jobs tile may leave out `failedVersion`.
 */
export function parseHealthResponse(value: unknown): Omit<HealthData, 'tiles'> & { tiles: ShownHealthTile[] } {
  const copy: unknown = structuredClone(value);
  const tiles = (copy as { data?: { tiles?: unknown } } | null)?.data?.tiles;
  const legacy = Array.isArray(tiles) ? tiles.find((tile): tile is { details: Record<string, unknown> } =>
    typeof tile === 'object' && tile !== null && (tile as { id?: unknown }).id === 'failed_jobs'
      && typeof (tile as { details?: unknown }).details === 'object' && (tile as { details?: unknown }).details !== null
      && !Object.hasOwn((tile as { details: object }).details, 'failedVersion')) : undefined;
  if (legacy) legacy.details.failedVersion = missingVersion;
  const data = parseResponse(healthResponseSchema, copy).data;
  if (!legacy) return data;
  return { ...data, tiles: data.tiles.map((tile): ShownHealthTile => {
    if (tile.id !== 'failed_jobs' || !tile.details) return tile;
    const details: NonNullable<Extract<ShownHealthTile, { id: 'failed_jobs' }>['details']> = { ...tile.details };
    delete details.failedVersion;
    return { ...tile, details };
  }) };
}

type Observed = { through: string; failedVersion: string };
/** The server's answer when the failed jobs changed since the tile was read. */
class FailedJobsChanged extends Error {}

/** Acknowledge failed jobs on the Background jobs tile: clears exactly the failures the tile counted when it was read. */
export function FailedJobsActions({ gymId, tile }: { gymId: string; tile: ShownHealthTile | undefined }) {
  // A tile without a version (an older server) can't name the failures it counted, so it offers no action.
  if (tile?.id !== 'failed_jobs' || !tile.details?.failedVersion) return null;
  const observed = tile.details.failed > 0 && tile.checkedAt
    ? { through: tile.checkedAt, failedVersion: tile.details.failedVersion } : null;
  return <AcknowledgeFailedJobs key={gymId} gymId={gymId} observed={observed}/>;
}

function AcknowledgeFailedJobs({ gymId, observed }: { gymId: string; observed: Observed | null }) {
  const cache = useQueryClient();
  // The tile read the dialog opened on; a refresh behind the dialog doesn't change what is confirmed.
  const [confirming, setConfirming] = useState<Observed | null>(null);
  const refresh = () => cache.invalidateQueries({ queryKey: ['health', gymId] });
  const mutation = useMutation({ mutationFn: async (body: Observed) => {
    const result = await api.POST(healthContracts.acknowledgeFailedJobs.path, { body });
    if (result.response.status === 409) throw new FailedJobsChanged('Failed jobs changed');
    if (!result.response.ok) throw new Error('Acknowledging failed jobs failed');
    return parseResponse(acknowledgeFailedJobsResponseSchema, result.data).data;
  }, onSuccess: async () => { setConfirming(null); await refresh(); },
  onError: async error => { if (error instanceof FailedJobsChanged) await refresh(); } });
  const close = () => { mutation.reset(); setConfirming(null); };
  const changed = mutation.error instanceof FailedJobsChanged;
  if (!observed && !confirming) return null;
  return <div className="mt-4 border-t border-border pt-4">
    {observed && <Button variant="outline" className="w-full sm:w-auto" onClick={() => { mutation.reset(); setConfirming(observed); }}>{label('acknowledge')}</Button>}
    {confirming && <Dialog title={label('acknowledgeTitle')} closeLabel={label('acknowledgeClose')} onClose={close} dismissible={!mutation.isPending}>
      <div className="space-y-4 break-words">
        <p>{label('acknowledgeHelp')}</p>
        {mutation.isError && <Alert variant="error" focusOnReveal>
          {label(changed ? 'acknowledgeChanged' : 'acknowledgeFailed')}</Alert>}
        <div className="flex flex-col gap-3 sm:flex-row">
          {!changed && <Button disabled={mutation.isPending} onClick={() => mutation.mutate(confirming)}>{label(mutation.isPending ? 'acknowledging' : 'acknowledgeConfirm')}</Button>}
          <Button variant="outline" disabled={mutation.isPending} onClick={close}>{label(changed ? 'acknowledgeReview' : 'acknowledgeCancel')}</Button>
        </div>
      </div>
    </Dialog>}
  </div>;
}

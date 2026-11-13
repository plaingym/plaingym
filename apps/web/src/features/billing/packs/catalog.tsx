// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClassPack } from '@plaingym/shared/contracts';
import { formatMinorUnits } from '@plaingym/shared/money';
import { Button } from '../../../components/ui/button.js';
import { CheckboxField } from '../../../components/ui/select.js';
import { LoadingState, ErrorState, EmptyState } from '../../../components/ui/states.js';
import { packCatalogKey, packClient, type PackClient } from './api.js';
import { PackEditor } from './editor.js';
import { text } from './messages.js';

export function PackCatalog({ gymId, client = packClient }: { gymId: string; client?: PackClient }) {
  // Under the catalog key, so the tax section's refreshes (an archive that detaches a rate, a new rate) reload packs too.
  const cache = useQueryClient(), key = ['billing', gymId, 'catalog', 'pack-settings'];
  const [archived, setArchived] = useState(false), [editor, setEditor] = useState<ClassPack | 'new' | null>(null);
  const data = useQuery({ queryKey: key, queryFn: async () => {
    const [taxes, settings] = await Promise.all([client.taxes(), client.settings()]);
    return { taxes, currency: settings.currency };
  } });
  const refresh = () => { setEditor(null); void cache.invalidateQueries({ queryKey: ['billing', gymId] }); };
  const packs = useQuery({ queryKey: packCatalogKey(gymId), queryFn: () => client.packs() });
  const rows = packs.data?.filter(pack => archived || pack.active);
  return <section aria-label={text('catalogTitle')} className="min-w-0 space-y-4 wrap-anywhere border-t pt-5">
    <h2 className="text-lg font-semibold">{text('catalogTitle')}</h2>
    {(data.isPending || packs.isPending) && <LoadingState/>}{(data.isError || packs.isError) && <ErrorState onRetry={() => { void data.refetch(); void packs.refetch(); }}/> }
    {data.data && packs.data && <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CheckboxField label={text('showArchived')} checked={archived} onChange={event => setArchived(event.target.checked)}/>
        <Button onClick={() => setEditor('new')}>{text('createPack')}</Button>
      </div>
      {!rows?.length && <EmptyState title={text('noPacks')}/>}
      <ul className="grid min-w-0 gap-3 lg:grid-cols-2">{rows?.map(pack => <li key={pack.id} className="min-w-0 space-y-2 rounded-lg border p-4">
        <h3 className="font-semibold">{pack.name}</h3><p className="text-sm text-muted-foreground">{text(pack.active ? 'active' : 'archived')}</p>
        <p>{formatMinorUnits(pack.amountCents, pack.currency)} · {text('creditCount', { count: pack.credits })}</p>
        <p>{pack.expiryDays === null ? text('neverExpires') : text('expiresDays', { days: pack.expiryDays })}</p>
        <Button variant="outline" className="w-full wrap-anywhere sm:w-auto" onClick={() => setEditor(pack)}>{text('editNamed', { name: pack.name })}</Button>
      </li>)}</ul>
      {editor && <PackEditor {...(editor === 'new' ? {} : { record: editor })} currency={data.data.currency} taxes={data.data.taxes} client={client} close={refresh} saved={refresh}/>}
    </>}
  </section>;
}

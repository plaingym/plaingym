// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import type { Rank, CreateRankRequest } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { useDraft } from '../../lib/use-draft.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogActions, DialogCancel } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField } from '../../components/ui/select.js';

export const coreCriteria = [
  { id: 'classes-since-promotion', key: 'classes' }, { id: 'time-at-rank', key: 'days' }, { id: 'minimum-age', key: 'age' },
] as const;
export const text = (key: string) => t('ranks/ranks:' + key);
/** Adds or edits a rank in a dialog. `message` repeats the page's save result inside the dialog. */
export function RankEditor({ rank, rankSystemId, nextPosition, busy, create, update, cancel, message }: {
  rank?: Rank; rankSystemId: string; nextPosition: number; busy: boolean;
  create: (body: CreateRankRequest) => Promise<void>; update: (body: Partial<Omit<CreateRankRequest, 'rankSystemId'>>) => Promise<void>;
  cancel: () => void; message?: string;
}) {
  // Position keeps the typed text, so the field can be cleared and `required` still applies; requests send a number.
  const draft = useDraft({ name: rank?.name ?? '', position: String(rank?.position ?? nextPosition),
    color: rank?.color?.toLowerCase() ?? (rank ? null : '#ffffff'), subRanks: rank?.subRanks ?? [], criteria: rank?.criteria ?? [] },
  value => ({ ...value, name: value.name.trim(), position: String(Number(value.position)), color: value.color?.toLowerCase() ?? null }));
  const { subRanks } = draft.values;
  const setSubRanks = (value: typeof subRanks) => draft.set('subRanks', value);
  const [hasColor, setHasColor] = useState(rank ? rank.color !== null : true);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rank) { const { position, ...values } = draft.values; await create({ rankSystemId, ...values, position: Number(position) }); return; }
    const { position, ...changes } = draft.changes();
    if (position === undefined && !Object.keys(changes).length) { cancel(); return; }
    await update({ ...changes, ...(position === undefined ? {} : { position: Number(position) }) });
  }
  function move(index: number, direction: number) {
    const rows = [...subRanks], other = index + direction;
    if (other < 0 || other >= rows.length) return;
    [rows[index], rows[other]] = [rows[other]!, rows[index]!]; setSubRanks(rows);
  }
  const title = text(rank ? 'editRank' : 'addRank');
  return <Dialog title={title} description={rank?.name} closeLabel={text('closeDialog')} dismissible={!busy}
    unsavedChanges={draft.dirty} onClose={cancel}>
    <form onSubmit={(event) => void submit(event)} className="space-y-6" aria-label={title}>
      {message && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Label className="grid gap-2">{text('name')}<Input name="name" required value={draft.values.name} onChange={event => draft.set('name', event.target.value)}/></Label>
          <Label className="grid gap-2">{text('position')}<Input type="number" name="position" min="0" max="2147483647" required value={draft.values.position} onChange={event => draft.set('position', event.target.value)}/></Label>
          <CheckboxField label={text('useColor')} checked={hasColor} onChange={event => { setHasColor(event.target.checked); draft.set('color', event.target.checked ? rank?.color?.toLowerCase() ?? '#ffffff' : null); }}/>
          {hasColor && <Label className="grid gap-2">{text('color')}<Input type="color" name="color" value={draft.values.color ?? '#ffffff'} onChange={event => draft.set('color', event.target.value.toLowerCase())} className="w-24 p-1"/></Label>}
        </div>
        <fieldset className="min-w-0 space-y-3"><legend className="font-medium">{text('subRanks')}</legend>
          {subRanks.length === 0 && <p className="text-sm text-muted-foreground">{text('noSubRanks')}</p>}
          {subRanks.map((subRank, index) => <div key={subRank.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-2 lg:grid-cols-[1fr_auto_auto_auto]">
            <Label className="col-span-2 grid gap-2 lg:col-span-1">{text('subRank')} {index + 1}<Input required value={subRank.name} onChange={(event) => setSubRanks(subRanks.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/></Label>
            <Button variant="outline" disabled={index === 0} onClick={() => move(index, -1)} aria-label={text('moveUp') + ' ' + (index + 1)}><span aria-hidden="true">↑</span>{text('moveUp')}</Button>
            <Button variant="outline" disabled={index === subRanks.length - 1} onClick={() => move(index, 1)} aria-label={text('moveDown') + ' ' + (index + 1)}><span aria-hidden="true">↓</span>{text('moveDown')}</Button>
            <Button variant="outline" onClick={() => setSubRanks(subRanks.filter((_, i) => i !== index))} className="col-span-2 lg:col-span-1" aria-label={text('remove') + ' ' + text('subRank') + ' ' + (index + 1)}>{text('remove')}</Button>
          </div>)}
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => setSubRanks([...subRanks, { id: 'step-' + crypto.randomUUID(), name: '' }])}>{text('addSubRank')}</Button>
        </fieldset>
        <fieldset className="min-w-0 space-y-3"><legend className="font-medium">{text('criteria')}</legend><p className="text-sm text-muted-foreground">{text('criteriaHelp')}</p>
          <div className="grid gap-4 sm:grid-cols-3">{coreCriteria.map((provider) => <Label key={provider.id} className="grid gap-2">{text(provider.key)}<Input type="number" min="0" max="2147483647" name={provider.id}
            value={String(draft.values.criteria.find(criterion => criterion.providerId === provider.id)?.config.target ?? '')}
            onChange={event => {
              const criteria = draft.values.criteria.filter(criterion => criterion.providerId !== provider.id);
              const target = Number(event.target.value), original = rank?.criteria.find(criterion => criterion.providerId === provider.id);
              if (event.target.value.trim()) criteria.push(original?.config.target === target ? original : { providerId: provider.id, config: { target } });
              // Restore the stored order when a target is reverted, so order alone never makes an edit.
              const order = rank?.criteria.map(criterion => criterion.providerId) ?? [];
              criteria.sort((left, right) => order.indexOf(left.providerId) - order.indexOf(right.providerId));
              draft.set('criteria', criteria);
            }}/></Label>)}</div>
          {(rank?.criteria ?? []).filter((criterion) => !coreCriteria.some((core) => core.id === criterion.providerId)).map((criterion, index) =>
            <p key={index} className="text-sm">{text('moduleCriterion')}: {criterion.providerId}</p>)}
        </fieldset>
        <DialogActions><Button type="submit">{text('save')}</Button><DialogCancel variant="outline">{text('cancel')}</DialogCancel></DialogActions>
      </fieldset>
    </form>
  </Dialog>;
}

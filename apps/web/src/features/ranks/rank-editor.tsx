// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import type { Rank, CreateRankRequest } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Dialog } from '../../components/ui/dialog.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { CheckboxField } from '../../components/ui/select.js';

export const coreCriteria = [
  { id: 'classes-since-promotion', key: 'classes' }, { id: 'time-at-rank', key: 'days' }, { id: 'minimum-age', key: 'age' },
] as const;
export const text = (key: string) => t('ranks/ranks:' + key);
/** Adds or edits a rank in a dialog. `message` repeats the page's save result inside the dialog. */
export function RankEditor({ rank, rankSystemId, nextPosition, busy, save, cancel, message }: {
  rank?: Rank; rankSystemId: string; nextPosition: number; busy: boolean;
  save: (body: CreateRankRequest) => Promise<void>; cancel: () => void; message?: string;
}) {
  const [subRanks, setSubRanks] = useState(rank?.subRanks ?? []);
  const [hasColor, setHasColor] = useState(rank ? rank.color !== null : true);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const criteria = [...(rank?.criteria.filter((item) => !coreCriteria.some((core) => core.id === item.providerId)) ?? [])];
    for (const provider of coreCriteria) {
      const value = String(form.get(provider.id) ?? '').trim();
      if (value) criteria.push({ providerId: provider.id, config: { target: Number(value) } });
    }
    await save({ rankSystemId, name: String(form.get('name')), position: Number(form.get('position')),
      color: hasColor ? String(form.get('color')) : null, subRanks, criteria });
  }
  function move(index: number, direction: number) {
    const rows = [...subRanks], other = index + direction;
    if (other < 0 || other >= rows.length) return;
    [rows[index], rows[other]] = [rows[other]!, rows[index]!]; setSubRanks(rows);
  }
  const title = text(rank ? 'editRank' : 'addRank');
  return <Dialog title={title} description={rank?.name} closeLabel={text('closeDialog')} onClose={cancel}>
    <form onSubmit={(event) => void submit(event)} className="space-y-6" aria-label={title}>
      {message && <p role="status" className="rounded-md border border-border bg-muted p-3 text-sm">{message}</p>}
      <fieldset disabled={busy} className="min-w-0 space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Label className="grid gap-2">{text('name')}<Input name="name" required defaultValue={rank?.name}/></Label>
          <Label className="grid gap-2">{text('position')}<Input type="number" name="position" min="0" max="2147483647" required defaultValue={rank?.position ?? nextPosition}/></Label>
          <CheckboxField label={text('useColor')} checked={hasColor} onChange={(event) => setHasColor(event.target.checked)}/>
          {hasColor && <Label className="grid gap-2">{text('color')}<Input type="color" name="color" defaultValue={rank?.color ?? '#ffffff'} className="w-24 p-1"/></Label>}
        </div>
        <fieldset className="min-w-0 space-y-3"><legend className="font-medium">{text('subRanks')}</legend>
          {subRanks.length === 0 && <p className="text-sm text-muted-foreground">{text('noSubRanks')}</p>}
          {subRanks.map((subRank, index) => <div key={subRank.id} className="grid grid-cols-[1fr_auto_auto] items-end gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <Label className="col-span-3 grid gap-2 sm:col-span-1">{text('subRank')} {index + 1}<Input required value={subRank.name} onChange={(event) => setSubRanks(subRanks.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/></Label>
            <Button variant="outline" size="icon" disabled={index === 0} onClick={() => move(index, -1)} aria-label={text('moveUp') + ' ' + (index + 1)}><span aria-hidden="true">↑</span></Button>
            <Button variant="outline" size="icon" disabled={index === subRanks.length - 1} onClick={() => move(index, 1)} aria-label={text('moveDown') + ' ' + (index + 1)}><span aria-hidden="true">↓</span></Button>
            <Button variant="outline" onClick={() => setSubRanks(subRanks.filter((_, i) => i !== index))} aria-label={text('remove') + ' ' + text('subRank') + ' ' + (index + 1)}>{text('remove')}</Button>
          </div>)}
          <Button variant="outline" className="w-full sm:w-auto" onClick={() => setSubRanks([...subRanks, { id: 'step-' + crypto.randomUUID(), name: '' }])}>{text('addSubRank')}</Button>
        </fieldset>
        <fieldset className="min-w-0 space-y-3"><legend className="font-medium">{text('criteria')}</legend><p className="text-sm text-muted-foreground">{text('criteriaHelp')}</p>
          <div className="grid gap-4 sm:grid-cols-3">{coreCriteria.map((provider) => <Label key={provider.id} className="grid gap-2">{text(provider.key)}<Input type="number" min="0" max="2147483647" name={provider.id}
            defaultValue={String(rank?.criteria.find((criterion) => criterion.providerId === provider.id)?.config.target ?? '')}/></Label>)}</div>
          {(rank?.criteria ?? []).filter((criterion) => !coreCriteria.some((core) => core.id === criterion.providerId)).map((criterion, index) =>
            <p key={index} className="text-sm">{text('moduleCriterion')}: {criterion.providerId}</p>)}
        </fieldset>
        <div className="flex flex-col gap-2 sm:flex-row"><Button type="submit">{text('save')}</Button><Button variant="outline" onClick={cancel}>{text('cancel')}</Button></div>
      </fieldset>
    </form>
  </Dialog>;
}

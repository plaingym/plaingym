// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import type { Rank, CreateRankRequest } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Card } from '../../components/ui/card.js';

export const coreCriteria = [
  { id: 'classes-since-promotion', key: 'classes' }, { id: 'time-at-rank', key: 'days' }, { id: 'minimum-age', key: 'age' },
] as const;
export const text = (key: string) => t('ranks/ranks:' + key);
export function RankEditor({ rank, rankSystemId, nextPosition, busy, save, cancel }: {
  rank?: Rank; rankSystemId: string; nextPosition: number; busy: boolean;
  save: (body: CreateRankRequest) => Promise<void>; cancel: () => void;
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
  return <Card><form onSubmit={(event) => void submit(event)} className="space-y-4">
    <h3 className="text-lg font-semibold">{text(rank ? 'editRank' : 'addRank')}</h3>
    <fieldset disabled={busy} className="space-y-4">
      <Label className="block">{text('name')}<Input name="name" required defaultValue={rank?.name}/></Label>
      <Label className="block">{text('position')}<Input type="number" name="position" min="0" max="2147483647" required defaultValue={rank?.position ?? nextPosition}/></Label>
      <Label className="flex items-center gap-2"><input type="checkbox" checked={hasColor} onChange={(event) => setHasColor(event.target.checked)}/>{text('useColor')}</Label>
      {hasColor && <Label className="block">{text('color')}<Input type="color" name="color" defaultValue={rank?.color ?? '#ffffff'} className="w-24"/></Label>}
      <h4 className="font-medium">{text('subRanks')}</h4>
      {subRanks.map((subRank, index) => <div key={subRank.id} className="flex flex-wrap items-center gap-2">
        <Label>{text('subRank')} {index + 1}<Input required value={subRank.name} onChange={(event) => setSubRanks(subRanks.map((item, i) => i === index ? { ...item, name: event.target.value } : item))}/></Label>
        <Button variant="outline" disabled={index === 0} onClick={() => move(index, -1)} aria-label={text('moveUp') + ' ' + (index + 1)}>↑</Button>
        <Button variant="outline" disabled={index === subRanks.length - 1} onClick={() => move(index, 1)} aria-label={text('moveDown') + ' ' + (index + 1)}>↓</Button>
        <Button variant="outline" onClick={() => setSubRanks(subRanks.filter((_, i) => i !== index))}>{text('remove')}</Button>
      </div>)}
      <Button variant="outline" onClick={() => setSubRanks([...subRanks, { id: 'step-' + crypto.randomUUID(), name: '' }])}>{text('addSubRank')}</Button>
      <h4 className="font-medium">{text('criteria')}</h4><p className="text-sm text-muted-foreground">{text('criteriaHelp')}</p>
      {coreCriteria.map((provider) => <Label key={provider.id} className="block">{text(provider.key)}<Input type="number" min="0" max="2147483647" name={provider.id}
        defaultValue={String(rank?.criteria.find((criterion) => criterion.providerId === provider.id)?.config.target ?? '')}/></Label>)}
      {(rank?.criteria ?? []).filter((criterion) => !coreCriteria.some((core) => core.id === criterion.providerId)).map((criterion, index) =>
        <p key={index} className="text-sm">{text('moduleCriterion')}: {criterion.providerId}</p>)}
      <div className="flex gap-2"><Button type="submit">{text('save')}</Button><Button variant="outline" onClick={cancel}>{text('cancel')}</Button></div>
    </fieldset>
  </form></Card>;
}

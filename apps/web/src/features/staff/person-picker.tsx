// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import type { PersonKind, PersonOption, StaffClient } from './client.js';

const text = (key: string) => t('staff/profiles:' + key);
/** Selection is explicit: typing a search never changes an existing link. */
export function PersonPicker({ name, kind, initialId = '', services, onChange }: {
  name: string; kind: PersonKind; initialId?: string; services: StaffClient; onChange?: (id: string) => void;
}) {
  const inputId = useId();
  const [selected, setSelected] = useState<PersonOption | null>(initialId ? { id: initialId, displayName: text('currentLink'), email: null } : null);
  const [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ data: PersonOption[]; total: number } | null>(null);
  const [error, setError] = useState(false), [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!initialId) return;
    let active = true;
    const unavailable = { id: initialId, displayName: text('linkUnavailable'), email: null };
    const resolve = (person: PersonOption | null) => { if (active) setSelected(current => current?.id === initialId ? person ?? unavailable : current); };
    void services.person(kind, initialId).then(resolve, () => resolve(null));
    return () => { active = false; };
  }, [initialId, kind, services]);
  useEffect(() => {
    let active = true; setLoading(true); setPage(null); setError(false);
    const timer = setTimeout(() => {
      void services.people(kind, search.trim(), offset).then(result => { if (active) setPage(result); })
        .catch(() => { if (active) setError(true); }).finally(() => { if (active) setLoading(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [kind, search, offset, services]);
  function choose(person: PersonOption | null) { setSelected(person); onChange?.(person?.id ?? ''); }
  return <div className="min-w-0 space-y-3">
    <input type="hidden" name={name} value={selected?.id ?? ''}/>
    <Label htmlFor={inputId}>{text(kind === 'member' ? 'findMember' : 'findAccount')}</Label>
    <Input id={inputId} type="search" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }}
      onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }}/>
    {selected && <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border p-3">
      <p className="min-w-0 break-words text-sm"><span className="font-medium">{text('selectedPerson')}: </span>{selected.displayName}
        {selected.email && selected.email !== selected.displayName && <span className="block break-all text-muted-foreground">{selected.email}</span>}</p>
      <Button type="button" variant="outline" onClick={() => choose(null)}>{text('clearPerson')}</Button>
    </div>}
    {error && <Alert variant="error">{text('peopleError')}</Alert>}
    {loading ? <p role="status" className="text-sm text-muted-foreground">{text('loadingPeople')}</p> : page && <>
      {page.data.length ? <ul aria-label={text('peopleResults')} className="max-h-56 space-y-2 overflow-y-auto">
        {page.data.map(person => <li key={person.id}><Button type="button" variant="outline" aria-pressed={selected?.id === person.id}
          aria-label={person.displayName + (person.email && person.email !== person.displayName ? ' ' + person.email : '')}
          className="h-auto min-h-11 w-full justify-start whitespace-normal py-3 text-left" onClick={() => choose(person)}>
          <span className="min-w-0 break-words">{person.displayName}{person.email && person.email !== person.displayName && <span className="block break-all text-xs font-normal text-muted-foreground">{' '}{person.email}</span>}</span>
        </Button></li>)}
      </ul> : <p className="text-sm text-muted-foreground">{text('noPeople')}</p>}
      <Pager offset={offset} total={page.total} limit={25} onChange={setOffset} previousLabel={text('previous')} nextLabel={text('next')}/>
    </>}
  </div>;
}

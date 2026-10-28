// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../lib/i18n.js';
import { Input } from './input.js';
import { Label } from './label.js';

/** One search/selection control. Suggestions stay in flow so scrollable dialogs never clip them. */
export function Autocomplete({ label, value, query, options, onQueryChange, onChange, loading = false, required = false }: {
  label: string; value: string; query: string; options: readonly { id: string; label: string }[];
  onQueryChange(query: string): void; onChange(id: string): void; loading?: boolean; required?: boolean;
}) {
  const id = useId(), listId = id + '-list', input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const visible = open && !loading, option = visible ? options[active] : undefined;
  useEffect(() => { input.current?.setCustomValidity(required && !value ? t('shell/shell:selectSuggestion') : ''); }, [required, value]);
  useEffect(() => { if (open) document.getElementById(id + '-option-' + active)?.scrollIntoView?.({ block: 'nearest' }); }, [active, open, id]);
  function choose(item: { id: string; label: string }) { onQueryChange(item.label); onChange(item.id); setOpen(false); }
  return <div className="min-w-0 space-y-2">
    <Label htmlFor={id}>{label}</Label>
    <Input ref={input} id={id} role="combobox" autoComplete="off" value={query} required={required}
      aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={option ? id + '-option-' + active : undefined}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onChange={event => { onQueryChange(event.target.value); onChange(''); setActive(0); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); setOpen(true);
          setActive(index => !open ? 0 : Math.max(0, Math.min(options.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))));
        } else if (event.key === 'Home' && open) { event.preventDefault(); setActive(0); }
        else if (event.key === 'End' && open) { event.preventDefault(); setActive(Math.max(0, options.length - 1)); }
        else if (event.key === 'Enter' && open) { event.preventDefault(); if (option) choose(option); }
        else if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
      }} />
    {open && <div className="rounded-lg border border-input bg-background p-1">
      <ul id={listId} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto">
        {!loading && options.map((item, index) => <li key={item.id} id={id + '-option-' + index} role="option" aria-selected={item.id === value}
          className={'flex min-h-11 cursor-pointer items-center break-words rounded px-3 py-2 text-sm ' + (index === active ? 'bg-secondary' : '')}
          onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>{item.label}</li>)}
      </ul>
      <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{t(loading ? 'shell/shell:loading' : options.length ? 'shell/shell:suggestionsHelp' : 'shell/shell:noSuggestions')}</p>
    </div>}
  </div>;
}

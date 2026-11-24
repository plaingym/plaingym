// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { joinPhone, phoneCountryOptions, splitPhone } from '@plaingym/shared/phone-countries';
import { t } from '../../lib/i18n.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { Select } from './select.js';

/**
 * A country code choice and a phone number. The value is `+<calling code> <number>` unless the number starts with + or with
 * the chosen country's international prefix (`00`, or `011` for +1), so the server's own parsing reads it as before.
 * `onChange` runs only on user input, never on render or when the parent resets `value`. A new `resetKey` drops what the
 * person chose, even when the value is unchanged (a reset to `''` after choosing a country with no number). `error` shows
 * under the field and marks the number invalid.
 */
export function PhoneInput({ id, label, value, onChange, defaultCountry, hint, error, resetKey, maxLength = 95, autoComplete = 'tel' }: {
  id: string; label: string; value: string; onChange: (value: string) => void; defaultCountry?: string | null | undefined; hint?: string;
  error?: string | undefined; resetKey?: string | number; maxLength?: number; autoComplete?: string;
}) {
  // What the person typed, kept only while the parent's value is the one this component last sent; otherwise the value rules.
  const [edit, setEdit] = useState<{ country: string; number: string } | null>(null);
  const [sent, setSent] = useState(value);
  const [key, setKey] = useState(resetKey);
  if (key !== resetKey) { setKey(resetKey); setEdit(null); setSent(value); }
  else if (edit && value !== sent) setEdit(null);
  const current = key !== resetKey ? null : edit;
  const { country, number } = current ?? splitPhone(value, defaultCountry);
  const options = useMemo(() => phoneCountryOptions('en'), []);
  const update = (next: { country: string; number: string }) => {
    const joined = joinPhone(next.country, next.number);
    setEdit(next); setSent(joined); onChange(joined);
  };
  const hintId = id + '-hint', errorId = id + '-error';
  const describedBy = [hint ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ') || undefined;
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={id}>{label}</Label>
    {/* Stacked at every width: the forms put this in a half-width column, where a row would squeeze the number below 44 px. */}
    <div className="flex min-w-0 flex-col gap-2">
      {/* A + number carries its own code, so the select shows no country rather than one the value doesn't use. */}
      <Select id={id + '-country'} aria-label={t('shell/phone:country')} value={number.trim().startsWith('+') ? '' : country}
        onChange={(event) => update({ country: event.target.value, number })}>
        <option value="">{t('shell/phone:choose')}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      <Input id={id} type="tel" inputMode="tel" autoComplete={autoComplete} maxLength={maxLength} className="min-w-0" value={number}
        aria-invalid={error ? true : undefined} aria-describedby={describedBy}
        onChange={(event) => update({ country, number: event.target.value })}
        // The value sent is already trimmed; leaving the field shows it that way too.
        onBlur={() => { if (edit && number !== number.trim()) setEdit({ country, number: number.trim() }); }}/>
    </div>
    {hint ? <p id={hintId} className="text-sm text-muted-foreground">{hint}</p> : null}
    {error ? <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}

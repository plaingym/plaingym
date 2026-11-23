// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { joinPhone, phoneCountryOptions, splitPhone } from '@plaingym/shared/phone-countries';
import { t } from '../../lib/i18n.js';
import { Input } from './input.js';
import { Label } from './label.js';
import { Select } from './select.js';

/**
 * A country code choice and a phone number. The value is `+<calling code> <number>` unless the number starts with +, so
 * the server's own parsing reads it as before. `onChange` runs only on user input, never on render or when the parent resets `value`.
 */
export function PhoneInput({ id, label, value, onChange, defaultCountry, hint, maxLength = 95, autoComplete = 'tel-national' }: {
  id: string; label: string; value: string; onChange: (value: string) => void; defaultCountry?: string | null | undefined; hint?: string; maxLength?: number; autoComplete?: string;
}) {
  // What the person typed, kept only while the parent's value is the one this component last sent; otherwise the value rules.
  const [edit, setEdit] = useState<{ country: string; number: string } | null>(null);
  const [sent, setSent] = useState(value);
  if (edit && value !== sent) setEdit(null);
  const { country, number } = edit ?? splitPhone(value, defaultCountry);
  const options = useMemo(() => phoneCountryOptions('en'), []);
  const update = (next: { country: string; number: string }) => {
    const joined = joinPhone(next.country, next.number);
    setEdit(next); setSent(joined); onChange(joined);
  };
  return <div className="grid min-w-0 gap-2">
    <Label htmlFor={id}>{label}</Label>
    {/* Stacked at every width: the forms put this in a half-width column, where a row would squeeze the number below 44 px. */}
    <div className="flex min-w-0 flex-col gap-2">
      <Select id={id + '-country'} aria-label={t('shell/phone:country')} value={country} onChange={(event) => update({ country: event.target.value, number })}>
        <option value="">{t('shell/phone:choose')}</option>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </Select>
      <Input id={id} type="tel" inputMode="tel" autoComplete={autoComplete} maxLength={maxLength} className="min-w-0" value={number}
        onChange={(event) => update({ country, number: event.target.value })}
        // The value sent is already trimmed; leaving the field shows it that way too.
        onBlur={() => { if (edit && number !== number.trim()) setEdit({ country, number: number.trim() }); }}/>
    </div>
    {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
  </div>;
}

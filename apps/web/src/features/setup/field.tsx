// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { t } from '../../lib/i18n.js';
import { fieldChecks } from './checks.js';

/** A field's format check: the locale key of what's wrong with `value` (the form gives other fields), or null when it looks right. */
export type FieldCheck = (value: string, form: HTMLFormElement | null) => string | null;
/** Draft values of the open step, keyed by field name; never a password, secret, key or token (see `useDraft`). */
export const DraftContext = createContext<Readonly<Record<string, string>>>({});

/** Sets an input's value the way a person typing does, so React's form `onChange` and the field's own check see it. */
export function setValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function CheckMark() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false" className="size-4 shrink-0"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
}

/**
 * A labelled input. With `check`, it checks the value's format when the owner leaves it, then on every change: "Looks
 * right" with a check mark, or what's wrong, always as text tied to the input (`aria-describedby`, `aria-invalid`),
 * never colour or the icon alone. It checks the format only; the server's own checks (a test email, the storage
 * probe, Google's answer) still decide. A required field left empty says so once it has been visited.
 */
export function Field({ name, type = 'text', value, required = true, maxLength, minLength, hint, onEdit, check: given, label, id, invalid, describedBy,
  confirmOk = true, onLeave, recheckWith }: {
  name: string; type?: string; value?: string | undefined; required?: boolean; maxLength?: number | undefined; minLength?: number | undefined; hint?: string | undefined;
  onEdit?: (() => void) | undefined;
  /** The format check; by default the one `fieldChecks` has for this name, `null` for none. */
  check?: FieldCheck | null | undefined; label?: string | undefined; id?: string | undefined;
  /** Set by the form when the server refused this value; shown like a failed check. */
  invalid?: boolean | undefined; describedBy?: string | undefined;
  /** Whether an `ok` result says "Looks right"; a key pair that only the server can test keeps it quiet. */
  confirmOk?: boolean | undefined;
  /** Runs when the owner leaves the field, before its check; a message shows under the input until the next change. */
  onLeave?: ((input: HTMLInputElement) => string | null) | undefined;
  /** Other fields in the form that, when changed, should recheck this one once it has been checked. */
  recheckWith?: readonly string[] | undefined;
}) {
  const draft = useContext(DraftContext), check = given === undefined ? fieldChecks[name] : given;
  const fieldId = id ?? 'setup-' + name, hintId = fieldId + '-hint', checkId = fieldId + '-check', noteId = fieldId + '-note';
  const inputRef = useRef<HTMLInputElement>(null);
  // null until the owner first leaves the field; then 'ok', 'empty' (an optional field left blank) or the problem's locale key.
  const [result, setResult] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const validate = (input: HTMLInputElement) => {
    const current = input.value;
    setResult(!current.trim() ? required ? 'check.required' : 'empty' : check?.(current, input.form) ?? 'ok');
  };
  // The form's input listener outlives one render, so it reads the latest check and result through refs.
  const validateRef = useRef(validate), resultRef = useRef(result);
  validateRef.current = validate; resultRef.current = result;
  const recheckNames = recheckWith?.join(',');
  useEffect(() => {
    const input = inputRef.current, form = input?.form, names = recheckNames ? recheckNames.split(',') : undefined;
    if (!input || !form || !names?.length) return;
    const recheck = (event: Event) => {
      if (event.target instanceof HTMLInputElement && names.includes(event.target.name)) {
        setNote(null);
        if (resultRef.current !== null) validateRef.current(input);
      }
    };
    form.addEventListener('input', recheck);
    return () => form.removeEventListener('input', recheck);
  }, [recheckNames]);
  const visible = !invalid && Boolean(check) && result !== null && result !== 'empty' && (confirmOk || result !== 'ok');
  const problem = visible && result !== 'ok' ? result : null, bad = invalid || problem !== null;
  const describe = [hint ? hintId : null, note ? noteId : null, visible ? checkId : null, describedBy ?? null].filter(Boolean).join(' ') || undefined;
  return <div className="min-w-0 space-y-2"><Label htmlFor={fieldId}>{label ?? t('setup/setup:' + name)}</Label>
    <Input ref={inputRef} id={fieldId} name={name} type={type} defaultValue={draft[name] ?? value} required={required} maxLength={maxLength} minLength={minLength}
      aria-invalid={bad || undefined} aria-describedby={describe} spellCheck={type === 'password' || name.toLowerCase().includes('id') ? false : undefined}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      onBlur={(event) => { const shown = onLeave?.(event.currentTarget) ?? null; if (shown !== null) setNote(shown); if (check) validate(event.currentTarget); }}
      onChange={(event: ChangeEvent<HTMLInputElement>) => { onEdit?.(); setNote(null); if (check && result !== null) validate(event.currentTarget); }} />
    {note && <p id={noteId} role="status" className="text-sm">{note}</p>}
    {hint && <p id={hintId} className="text-sm text-muted-foreground">{hint}</p>}
    {/* The line's height is kept even while it is empty: a result that appeared as the owner pressed a button would
        otherwise move the button between mousedown and mouseup, and the click would be lost. */}
    {check && <p id={checkId} className={'min-h-5 text-sm ' + (problem ? 'font-medium text-destructive' : 'flex items-center gap-1.5')}>
      {!visible ? null : problem ? t('setup/setup:' + problem) : <><CheckMark />{t('setup/setup:check.ok')}</>}</p>}
  </div>;
}

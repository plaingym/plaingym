// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/table.js';
import { t } from '../../lib/i18n.js';
import { ApiError } from '../../lib/api.js';
import { useDialogOperation } from '../../components/ui/dialog.js';
export const text = (key: string) => t('members/members:' + key);
export function Field({ name, value, onChange, type = 'text', required = false }: { name: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return <Label className="grid gap-2">{text(name)}<Input type={type} value={value} required={required} onChange={(event) => onChange(event.target.value)}/></Label>;
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? <Alert role="alert">{text(error instanceof ApiError && error.status === 409 ? 'conflict' : 'failed')}</Alert> : null;
}
export function useMemberSave() {
  const client = useQueryClient(), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  useDialogOperation(busy);
  return { error, busy, async save(action: () => Promise<unknown>, done?: () => void) {
    setBusy(true); setError(undefined);
    try { await action(); await client.invalidateQueries({ queryKey: ['members'] }); done?.(); }
    catch (error) { setError(error); }
    finally { setBusy(false); }
  } };
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Keeps a form's unsaved edits across refetches. Only edited fields are drafts; the others follow the
 * latest server values, so saving another part of the same record (which advances its revision)
 * never discards a draft. `changes()` returns the edits, or throws a conflict when another save
 * changed an edited field after editing began. Call `reset` once the saved record has reloaded. */
export function useDraft<T extends Record<string, unknown>>(server: T) {
  const [edits, setEdits] = useState<{ [K in keyof T]?: { value: T[K]; base: T[K] } }>({});
  const values = { ...server };
  for (const key of Object.keys(edits) as (keyof T)[]) values[key] = edits[key]!.value;
  return {
    values,
    set<K extends keyof T>(key: K, value: T[K]) {
      setEdits((previous) => ({ ...previous, [key]: { value, base: previous[key] ? previous[key].base : server[key] } }));
    },
    changes(): Partial<T> {
      const result: Partial<T> = {};
      for (const key of Object.keys(edits) as (keyof T)[]) {
        if (!same(edits[key]!.base, server[key])) throw new ApiError(409, 'conflict');
        if (!same(edits[key]!.value, server[key])) result[key] = edits[key]!.value;
      }
      return result;
    },
    reset() { setEdits({}); },
  };
}
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"><h2 className="text-lg font-semibold">{text(title)}</h2>{children}</section>;
}
const statusTones = { active: 'success', trial: 'default', prospect: 'default', frozen: 'warning', cancelled: 'muted', visitor: 'muted' } as const;
export function StatusBadge({ status }: { status: keyof typeof statusTones }) {
  return <Badge tone={statusTones[status]} className="shrink-0">{text('status.' + status)}</Badge>;
}

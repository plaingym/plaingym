// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ApiError } from './api.js';

export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Keeps unsaved edits across refetches, lets untouched fields follow the server, and reports conflicts
 * when the server changes an edited field. Normalize only comparisons, leaving typed values intact. */
export function useDraft<T extends Record<string, unknown>>(server: T, normalize: (value: T) => T = value => value) {
  const [edits, setEdits] = useState<{ [K in keyof T]?: { value: T[K]; base: T[K]; conflicted?: boolean } }>({});
  const normalizedServer = normalize(server), values = { ...server };
  for (const key of Object.keys(edits) as (keyof T)[]) values[key] = edits[key]!.value;
  const normalizedValues = normalize(values);
  return {
    values,
    /** Safe during conflicts: closing a draft must not invoke the save-time conflict check. */
    dirty: Object.keys(edits).some(key => !same(normalizedValues[key], normalizedServer[key])),
    set<K extends keyof T>(key: K, value: T[K]) {
      setEdits(previous => ({ ...previous, [key]: { base: normalizedServer[key], ...previous[key], value } }));
    },
    changes(): Partial<T> {
      const normalized = normalize(values), result: Partial<T> = {};
      for (const key of Object.keys(edits) as (keyof T)[]) {
        const edit = edits[key]!;
        if (edit.conflicted || !same(edit.base, normalizedServer[key])) throw new ApiError(409, 'conflict');
        if (!same(normalized[key], normalizedServer[key])) result[key] = normalized[key];
      }
      return result;
    },
    reset() { setEdits({}); },
    /** Reconcile a completed save against the latest server read and any edits made during the request. */
    reconcileSaved(submitted: Partial<T>, refetched: T) {
      const saved = normalize(refetched);
      setEdits(previous => {
        const visible = { ...refetched };
        for (const key of Object.keys(previous) as (keyof T)[]) visible[key] = previous[key]!.value;
        const current = normalize(visible), remaining = { ...previous };
        for (const key of Object.keys(submitted) as (keyof T)[]) {
          const edit = previous[key];
          if (!edit) continue;
          if (same(current[key], submitted[key])) delete remaining[key];
          else if (same(saved[key], submitted[key])) remaining[key] = { value: edit.value, base: saved[key] };
          // A later revision can restore the original value, which would otherwise pass the baseline check.
          else remaining[key] = { ...edit, conflicted: true };
        }
        return remaining;
      });
    },
  };
}

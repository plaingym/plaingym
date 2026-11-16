// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ApiError } from './api.js';

export const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Keeps unsaved edits across refetches, lets untouched fields follow the server, and reports conflicts
 * when the server changes an edited field. Normalize only comparisons, leaving typed values intact. */
export function useDraft<T extends Record<string, unknown>>(server: T, normalize: (value: T) => T = value => value) {
  const [edits, setEdits] = useState<{ [K in keyof T]?: { value: T[K]; base: T[K] } }>({});
  const normalizedServer = normalize(server), values = { ...server };
  for (const key of Object.keys(edits) as (keyof T)[]) values[key] = edits[key]!.value;
  const normalizedValues = normalize(values);
  return {
    values,
    /** Safe during conflicts: closing a draft must not invoke the save-time conflict check. */
    dirty: Object.keys(edits).some(key => !same(normalizedValues[key], normalizedServer[key])),
    set<K extends keyof T>(key: K, value: T[K]) {
      setEdits(previous => ({ ...previous, [key]: { value, base: previous[key] ? previous[key].base : normalizedServer[key] } }));
    },
    changes(): Partial<T> {
      const normalized = normalize(values), result: Partial<T> = {};
      for (const key of Object.keys(edits) as (keyof T)[]) {
        if (!same(edits[key]!.base, normalizedServer[key])) throw new ApiError(409, 'conflict');
        if (!same(normalized[key], normalizedServer[key])) result[key] = normalized[key];
      }
      return result;
    },
    reset() { setEdits({}); },
  };
}

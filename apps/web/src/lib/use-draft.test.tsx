// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { ApiError } from './api.js';
import { useDraft } from './use-draft.js';

afterEach(cleanup);
it('keeps edits across unrelated saves and reports concurrent edits to the same field', () => {
  const hook = renderHook(server => useDraft(server), { initialProps: { name: 'Pat', phone: '123' } });
  act(() => hook.result.current.set('name', 'Draft'));
  expect(hook.result.current.dirty).toBe(true);
  hook.rerender({ name: 'Pat', phone: '456' });
  expect(hook.result.current.values).toEqual({ name: 'Draft', phone: '456' });
  expect(hook.result.current.changes()).toEqual({ name: 'Draft' });
  hook.rerender({ name: 'Another save', phone: '456' });
  expect(hook.result.current.dirty).toBe(true);
  expect(() => hook.result.current.changes()).toThrow(ApiError);
  act(() => hook.result.current.reset());
  expect(hook.result.current.values).toEqual({ name: 'Another save', phone: '456' });
  expect(hook.result.current.changes()).toEqual({});
  expect(hook.result.current.dirty).toBe(false);
});
it('compares normalized values without trimming the typed draft', () => {
  const hook = renderHook(server => useDraft(server, value => ({ name: value.name.trim() })), { initialProps: { name: ' Pat ' } });
  act(() => hook.result.current.set('name', 'Pat  '));
  expect(hook.result.current.values.name).toBe('Pat  ');
  expect(hook.result.current.changes()).toEqual({});
  expect(hook.result.current.dirty).toBe(false);
  hook.rerender({ name: 'Pat' });
  act(() => hook.result.current.set('name', ' New name '));
  expect(hook.result.current.changes()).toEqual({ name: 'New name' });
});

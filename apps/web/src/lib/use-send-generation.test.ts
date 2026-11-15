// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useSendGeneration } from './send-generation.js';

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

it('keeps a lost request across rerenders and remounts until a definite response settles it', () => {
  const request = { householdId: 'home' }, first = renderHook(() => useSendGeneration('test.invitation'));
  const generation = first.result.current.generation(request);
  first.rerender();
  expect(first.result.current.generation(request)).toBe(generation);
  first.unmount();
  const second = renderHook(() => useSendGeneration('test.invitation'));
  expect(second.result.current.generation(request)).toBe(generation);
  act(() => { expect(second.result.current.settle({ delivery: 'email' })).toBe(false); });
  expect(second.result.current.uncertain).toBe(false);
  expect(second.result.current.generation(request)).not.toBe(generation);
});

it('keeps an uncertain generation until a deliberate resend and clears its warning before the new request', () => {
  const hook = renderHook(() => useSendGeneration('test.invoice')), request = { invoiceId: 'invoice' };
  const generation = hook.result.current.generation(request);
  act(() => { expect(hook.result.current.settle({ outcome: 'unknown' })).toBe(true); });
  expect(hook.result.current.uncertain).toBe(true);
  expect(hook.result.current.generation(request)).toBe(generation);
  act(() => hook.result.current.resend());
  expect(hook.result.current.uncertain).toBe(false);
  const resent = hook.result.current.generation(request);
  expect(resent).not.toBe(generation);
  // A failed resend leaves its own key pending, without restoring the previous warning.
  hook.rerender();
  expect(hook.result.current.generation(request)).toBe(resent);
  expect(hook.result.current.uncertain).toBe(false);
});

it('clears a stale dialog warning while retaining the generation for a replay', () => {
  const hook = renderHook(() => useSendGeneration('test.portal')), request = { memberId: 'member' };
  const generation = hook.result.current.generation(request);
  act(() => { hook.result.current.settle({ outcome: 'unknown' }); });
  act(() => hook.result.current.reset());
  expect(hook.result.current.uncertain).toBe(false);
  expect(hook.result.current.generation(request)).toBe(generation);
  act(() => { hook.result.current.settle({ outcome: 'unknown' }); });
  expect(hook.result.current.uncertain).toBe(true);
});

it('keeps other requests and namespaces pending when one send settles', () => {
  const hook = renderHook(() => useSendGeneration('test.staff'));
  const first = hook.result.current.generation({ email: 'first@example.test' });
  const second = hook.result.current.generation({ email: 'second@example.test' });
  const other = renderHook(() => useSendGeneration('test.portal'));
  expect(other.result.current.generation({ email: 'second@example.test' })).not.toBe(second);
  act(() => { hook.result.current.settle({}); });
  expect(hook.result.current.generation({ email: 'first@example.test' })).toBe(first);
  expect(hook.result.current.generation({ email: 'second@example.test' })).not.toBe(second);
});

// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useAfterMount } from './after-mount.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it('turns true 100 ms after the component mounted', () => {
  const { result } = renderHook(() => useAfterMount());
  expect(result.current).toBe(false);
  advance(99);
  expect(result.current).toBe(false);
  advance(1);
  expect(result.current).toBe(true);
});

it('leaves no timer when the component unmounts first', () => {
  const { unmount } = renderHook(() => useAfterMount());
  advance(99);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

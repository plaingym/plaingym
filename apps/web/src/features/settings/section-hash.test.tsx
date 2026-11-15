// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { sectionHashLifetimeMs, useSectionHash } from './section-hash.js';

function Sections() {
  useSectionHash('target', true);
  return <div><section id="target" tabIndex={-1}>Target</section><button>Other section</button></div>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
it.each(['lifetime', 'click'])('stops scrolling and reclaiming focus after %s', async reason => {
  vi.useFakeTimers();
  window.history.replaceState(null, '', '#target');
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const view = render(<Sections/>);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(scroll).toHaveBeenCalled();
    if (reason === 'lifetime') await act(() => vi.advanceTimersByTimeAsync(sectionHashLifetimeMs));
    else fireEvent.click(window);
    scroll.mockClear();
    const button = view.getByRole('button');
    button.focus();
    view.container.querySelector('section')!.before(document.createElement('p'));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  } finally { HTMLElement.prototype.scrollIntoView = original; }
});

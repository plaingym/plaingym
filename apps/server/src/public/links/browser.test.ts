// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { linkBrowser } from './browser.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(purpose = 'update_card', tablet = false) {
  vi.useFakeTimers();
  const location = { pathname: '/l/token', href: 'https://gym.test/l/token?returned=1', reload: vi.fn(), replace: vi.fn() };
  vi.stubGlobal('location', location);
  document.body.dataset.purpose = purpose; document.body.dataset.tablet = String(tablet);
  document.body.innerHTML = '<p id="feedback"></p><button data-complete>Check again</button>'
    + ['busy', 'confirming', 'incomplete', 'conflict', 'failed'].map(key => `<span hidden data-message="${key}">${key}</span>`).join('');
  const fetch = vi.fn(async () => new Response(JSON.stringify({ data: { completed: false } })));
  vi.stubGlobal('fetch', fetch);
  return { location, fetch, feedback: document.getElementById('feedback')!, button: document.querySelector('button')! };
}
it.each(['update_card', 'pay_invoice', 'onboarding'])('automatically completes %s when the webhook arrives after the first request', async purpose => {
  const f = fixture(purpose);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { completed: false } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { completed: true } })));
  linkBrowser(); await vi.advanceTimersByTimeAsync(0);
  expect(f.feedback.textContent).toBe('confirming'); expect(f.button.disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.location.reload).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it('shows incomplete only after five increasing waits and retains the manual button', async () => {
  const f = fixture(); linkBrowser(); await vi.advanceTimersByTimeAsync(14999);
  expect(f.feedback.textContent).toBe('confirming'); expect(f.fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.fetch).toHaveBeenCalledTimes(6); expect(f.feedback.textContent).toBe('incomplete'); expect(f.button.disabled).toBe(false);
  f.button.click(); await vi.advanceTimersByTimeAsync(0); expect(f.fetch).toHaveBeenCalledTimes(7);
});
it.each([false, true])('refreshes the saved card on unfinished onboarding without repeating the return poll (tablet %s)', async tablet => {
  const f = fixture('onboarding', tablet);
  f.location.href += '&tablet=1';
  linkBrowser(); await vi.advanceTimersByTimeAsync(15000);
  expect(f.fetch).toHaveBeenCalledTimes(6);
  expect(f.location.replace).toHaveBeenCalledWith('/l/token?tablet=1');
  expect(f.location.reload).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Check again');
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).toHaveBeenCalledTimes(6);
});
it.each([201, 409, 503])('stops on HTTP %s and preserves the existing error message', async status => {
  const f = fixture(); f.fetch.mockResolvedValue(new Response('{}', { status })); linkBrowser();
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.feedback.textContent).toBe(status === 409 ? 'conflict' : 'failed');
});
it('does not automatically retry waiver signing', async () => {
  const f = fixture('sign_waiver'); linkBrowser(); await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).not.toHaveBeenCalled();
});
it('clears a completed tablet and stops polling when a tablet leaves', async () => {
  const f = fixture('update_card', true); f.fetch.mockResolvedValue(new Response(JSON.stringify({ data: { completed: true } })));
  linkBrowser(); await vi.advanceTimersByTimeAsync(0);
  expect(f.location.replace).toHaveBeenCalledWith('/l/cleared'); expect(document.body.textContent).toBe('');
  const next = fixture('update_card', true); linkBrowser(); await vi.advanceTimersByTimeAsync(0);
  window.dispatchEvent(new Event('pagehide')); await vi.advanceTimersByTimeAsync(20000);
  expect(next.fetch).toHaveBeenCalledOnce(); expect(document.body.textContent).toBe('');
});

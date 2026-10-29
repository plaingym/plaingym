// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { linkBrowser } from './browser.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
function fixture(purpose = 'update_card', tablet = false) {
  vi.useFakeTimers();
  const location = { pathname: '/l/token', href: 'https://gym.test/l/token?returned=1', reload: vi.fn(), replace: vi.fn(), assign: vi.fn() };
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', { replaceState: vi.fn() });
  document.body.dataset.purpose = purpose; document.body.dataset.tablet = String(tablet);
  document.body.innerHTML = '<main><p id="feedback"></p><button data-complete>Check again</button><footer>Source code</footer></main><template id="completed-message"><section tabindex="-1"><h1>You are all set</h1><p>Saved successfully</p></section></template>'
    + ['busy', 'confirming', 'incomplete', 'conflict', 'failed'].map(key => `<span hidden data-message="${key}">${key}</span>`).join('');
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: { completed: false } })));
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
  expect(f.fetch).toHaveBeenCalledTimes(2); expect(f.location.reload).not.toHaveBeenCalled();
  expect(document.querySelector('h1')?.textContent).toBe('You are all set');
  expect(document.querySelector('footer')?.textContent).toBe('Source code');
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/l/token');
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it('shows incomplete only after five increasing waits and retains the manual button', async () => {
  const f = fixture(); linkBrowser(); await vi.advanceTimersByTimeAsync(14999);
  expect(f.feedback.textContent).toBe('confirming'); expect(f.fetch).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.fetch).toHaveBeenCalledTimes(6); expect(f.feedback.textContent).toBe('incomplete'); expect(f.button.disabled).toBe(false);
  f.button.click(); await vi.advanceTimersByTimeAsync(0); expect(f.fetch).toHaveBeenCalledTimes(7);
});
it('confirms an onboarding return even with an unsubmitted portal claim form', async () => {
  const f = fixture('onboarding');
  document.querySelector('main')!.insertAdjacentHTML('beforeend', '<form data-portal-claim><input name="email"><button>Create portal access</button></form>');
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { completed: false } })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: { completed: true } })));
  linkBrowser(); await vi.advanceTimersByTimeAsync(1000);
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.fetch.mock.calls.every(([url]) => url.endsWith('/complete'))).toBe(true);
  expect(document.querySelector('h1')?.textContent).toBe('You are all set');
  expect(history.replaceState).toHaveBeenCalledWith(null, '', '/l/token');
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).toHaveBeenCalledTimes(2);
});
it.each((['return', 'manual'] as const).flatMap(mode => [false, true].map(tablet => [mode, tablet] as const)))(
  'refreshes only the saved card while preserving a waiver draft and its Checkout button (%s, tablet %s)', async (mode, tablet) => {
  const f = fixture('onboarding', tablet);
  if (mode === 'manual') f.location.href = 'https://gym.test/l/token';
  document.body.insertAdjacentHTML('beforeend', '<section data-card-panel><p data-card-status>No saved card</p><button data-checkout>Add card</button></section>');
  const checkout = document.querySelector<HTMLButtonElement>('[data-checkout]')!;
  f.fetch.mockImplementation(async (_url, init) => init?.method === 'POST'
    ? new Response(JSON.stringify({ data: { completed: false } }))
    : new Response('<section data-card-panel><p data-card-status>Card ending in 4242</p><button data-checkout>Add card</button></section>'));
  linkBrowser(); await vi.advanceTimersByTimeAsync(0);
  // The member starts a waiver while the delayed completion checks are still running.
  document.body.insertAdjacentHTML('beforeend', '<form data-waiver><input name="name"><canvas></canvas></form>');
  const name = document.querySelector<HTMLInputElement>('[name="name"]')!, canvas = document.querySelector('canvas')!;
  name.value = 'Payer draft'; canvas.width = 1234;
  if (mode === 'manual') { f.button.click(); await vi.advanceTimersByTimeAsync(0); }
  else await vi.advanceTimersByTimeAsync(15000);
  const calls = mode === 'manual' ? 2 : 7;
  expect(f.fetch).toHaveBeenCalledTimes(calls);
  expect(document.querySelector('[data-card-status]')?.textContent).toBe('Card ending in 4242');
  expect(document.querySelector('[name="name"]')).toBe(name); expect(name.value).toBe('Payer draft');
  expect(document.querySelector('canvas')).toBe(canvas); expect(canvas.width).toBe(1234);
  expect(f.location.replace).not.toHaveBeenCalled();
  expect(f.location.reload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(20000); expect(f.fetch).toHaveBeenCalledTimes(calls);
  expect(document.querySelector('[data-checkout]')).toBe(checkout);
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { url: 'https://checkout.example.test' } })));
  checkout.click(); await vi.advanceTimersByTimeAsync(0);
  expect(tablet ? f.location.replace : f.location.assign).toHaveBeenCalledWith('https://checkout.example.test');
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

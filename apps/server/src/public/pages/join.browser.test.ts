// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBrowserScript, joinPollIntervalMs, joinPollLimit } from './join.browser.js';
import { publicBrowserScript, refusalScript } from './browser.js';

const confirming = '<section data-join-confirming>Confirming</section>', welcome = '<section>Welcome</section>';
class Fake {
  hidden = new Set<string>();
  setAttribute(name: string) { this.hidden.add(name); }
  removeAttribute(name: string) { this.hidden.delete(name); }
}
/** Runs the served script against a minimal page: `waiting` is the confirming page, otherwise a page with neither marker. */
function load(waiting: boolean, answers: (call: number) => string | Error, readyState = 'complete') {
  const progress = new Fake(), stalled = new Fake();
  stalled.hidden.add('hidden');
  const reload = vi.fn(), stop = vi.fn(), listeners = new Map<string, () => void>();
  const document = { readyState, querySelector: (selector: string) => ({ '[data-join-confirming]': waiting ? {} : null, '[data-join-progress]': progress,
    '[data-join-stalled]': stalled }[selector] ?? null) };
  let calls = 0;
  const fetch = vi.fn(async () => {
    const answer = answers(calls++);
    if (answer instanceof Error) throw answer;
    return { ok: true, redirected: answer.startsWith('redirected:'), text: async () => answer };
  });
  const window = { location: { reload }, stop, addEventListener: (event: string, listener: () => void) => { listeners.set(event, listener); } };
  new Function('document', 'window', 'fetch', joinBrowserScript)(document, window, fetch);
  return { progress, stalled, reload, fetch, stop, listeners };
}
const tick = (times = 1) => vi.advanceTimersByTimeAsync(joinPollIntervalMs * times);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('join confirming poll', () => {
  it('asks /join/return with the join cookie every two seconds and reloads once it has settled, then stops', async () => {
    const page = load(true, call => call < 2 ? confirming : welcome);
    expect(page.fetch).not.toHaveBeenCalled();
    await tick();
    expect(page.fetch).toHaveBeenCalledWith('/join/return', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
    expect(page.reload).not.toHaveBeenCalled();
    await tick(2);
    expect(page.fetch).toHaveBeenCalledTimes(3); expect(page.reload).toHaveBeenCalledTimes(1);
    await tick(10);
    expect(page.fetch).toHaveBeenCalledTimes(3); expect(page.reload).toHaveBeenCalledTimes(1);
    // A settled page keeps its progress and never shows the stalled message.
    expect(page.stalled.hidden.has('hidden')).toBe(true);
  });
  it('gives up after its limit, hiding the progress and showing the stalled message', async () => {
    const page = load(true, () => confirming);
    await tick(joinPollLimit - 1);
    expect(page.fetch).toHaveBeenCalledTimes(joinPollLimit - 1); expect(page.stalled.hidden.has('hidden')).toBe(true);
    await tick();
    expect(page.fetch).toHaveBeenCalledTimes(joinPollLimit);
    expect(page.progress.hidden.has('hidden')).toBe(true); expect(page.stalled.hidden.has('hidden')).toBe(false);
    await tick(20);
    expect(page.fetch).toHaveBeenCalledTimes(joinPollLimit); expect(page.reload).not.toHaveBeenCalled();
  });
  it('treats a dropped request as another wait and carries on', async () => {
    const page = load(true, call => call === 0 ? new Error('offline') : call === 1 ? confirming : welcome);
    await tick(3);
    expect(page.fetch).toHaveBeenCalledTimes(3); expect(page.reload).toHaveBeenCalledTimes(1);
  });
  it('never stops the page, so no poll is cut off and the limit message shows', async () => {
    const page = load(true, () => confirming, 'loading');
    await tick(joinPollLimit);
    expect(page.stop).not.toHaveBeenCalled(); expect(page.listeners.has('load')).toBe(false);
    expect(page.progress.hidden.has('hidden')).toBe(true); expect(page.stalled.hidden.has('hidden')).toBe(false);
  });
  it('does not treat a redirected answer as a settled join', async () => {
    const page = load(true, call => call === 0 ? 'redirected:<p>Sign in</p>' : welcome);
    await tick();
    expect(page.reload).not.toHaveBeenCalled();
    await tick();
    expect(page.reload).toHaveBeenCalledTimes(1);
  });
  it('does nothing on a page that is not confirming', async () => {
    const page = load(false, () => welcome);
    await tick(10);
    expect(page.fetch).not.toHaveBeenCalled(); expect(page.reload).not.toHaveBeenCalled(); expect(page.stop).not.toHaveBeenCalled();
  });
});

describe('join and drop-in refusals', () => {
  const refusal = new Function(refusalScript + '\nreturn refusal;')() as (response: Response) => Promise<string>;
  it('says to retry only a full queue\'s 429, and calls any other 429 a limit', async () => {
    const busy = Response.json({ error: { code: 'rate_limited', details: { reason: ['busy'] } } }, { status: 429, headers: { 'Retry-After': '1' } });
    expect(await refusal(busy)).toBe('retry');
    expect(await refusal(Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'Retry-After': '900' } }))).toBe('limited');
    expect(await refusal(new Response('not json', { status: 429 }))).toBe('limited');
    expect(await refusal(Response.json({ error: { code: 'conflict' } }, { status: 409 }))).toBe('conflict');
    expect(await refusal(Response.json({ error: { code: 'internal' } }, { status: 500 }))).toBe('failed');
  });
  it('is what both scripts use for a refused post', () => {
    for (const script of [joinBrowserScript, publicBrowserScript]) {
      expect(script).toContain(refusalScript);
      expect(script).toContain('await refusal(response)');
    }
  });
});

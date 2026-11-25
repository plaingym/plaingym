// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBrowserScript, joinPollIntervalMs, joinPollLimit } from './join.browser.js';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { callingCode, internationalPrefixList, joinPhone, keepsInternationalPrefix } from '@plaingym/shared/phone-countries';
import { phoneScript, publicBrowserScript, refusalScript } from './browser.js';
import { phoneField } from './page.js';

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

describe('phone country choice in the browser scripts', () => {
  const formPhone = new Function(phoneScript + '\nreturn formPhone;')() as (form: unknown, fields: Map<string, string>) => string;
  /** A form whose country select has this option selected (null: no select at all). */
  const formWith = (selected: { getAttribute(name: string): string | null } | null) =>
    ({ querySelector: (selector: string) => selector === 'select[name=phoneCountry]' && selected ? { selectedOptions: [selected] } : null });
  const code = (value: string | null, prefix?: string, keep = false) => ({
    getAttribute: (name: string) => name === 'data-calling-code' ? value
      : name === 'data-international-prefix' ? (prefix ?? null)
      : name === 'data-keep-prefix' && keep ? 'true' : null,
  });
  it('joins the chosen calling code like the native form does', () => {
    expect(formPhone(formWith(code('1')), new Map([['phone', '604 555 0123']]))).toBe('+1 604 555 0123');
    expect(formPhone(formWith(code('1')), new Map([['phone', ' +44 20 7946 0018 ']]))).toBe('+44 20 7946 0018');
    expect(formPhone(formWith(code(null)), new Map([['phone', '604 555 0123']]))).toBe('604 555 0123');
    expect(formPhone(formWith(null), new Map([['phone', '604 555 0123']]))).toBe('604 555 0123');
    expect(formPhone(formWith(code('1')), new Map([['phone', '   ']]))).toBe('');
    expect(formPhone(formWith(code('1')), new Map())).toBe('');
  });
  it('matches joinPhone on every international-prefix case and falls back to 00 without the prefix attribute', () => {
    const cases: [string, string][] = [
      ['GB', '0044 20 7946 0018'], ['US', '011 44 20 7946 0018'], ['US', '(011) 44-20.7946 0018'],
      ['US', '011 +44 20 7946 0018'], ['GB', '00 (44) 20 7946 0018'], ['GB', '00 (44 20 7946 0018'],
      ['GB', '00 44) 20 7946 0018'], ['AU', '0014 44 20 7946 0018'], ['AU', '0011 44 20 7946 0018'],
      ['PW', '012 44 20 7946 0018'], ['SG', '019 44 20 7946 0018'], ['TW', '019 44 20 7946 0018'],
      ['SG', '6123 4567'], ['JP', '010 44 20 7946 0018'], ['RU', '810 44 20 7946 0018'],
      ['RU', '8 10 44 20 7946 0018'], ['JP', '03 1234 5678'], ['US', '0044 20 7946 0018'],
      ['GB', '00'], ['BR', '0021 44 20 7946 0018'], ['GB', '07700 900123'],
      ['CV', '00 44 20 7946 0018'], ['CV', '0 44 20 7946 0018'],
      ['GB', '00 (+44) 20 7946 0018'], ['GB', '00 ( +44) 20 7946 0018'],
      ['IL', '014 44 20 7946 0018'], ['MX', '09 44 20 7946 0018'],
      ['FI', '99511 44 20 7946 0018'], ['UY', '0174 44 20 7946 0018'],
      ['NZ', '0161 44 20 7946 0018'], ['CN', '00 44 20 7946 0018'],
    ];
    for (const [region, typed] of cases) {
      const regionCode = callingCode(region)!;
      const selected = code(regionCode, internationalPrefixList(regionCode).join(' '), keepsInternationalPrefix(regionCode));
      expect(formPhone(formWith(selected), new Map([['phone', typed]]))).toBe(joinPhone(region, typed));
    }
    expect(formPhone(formWith(code('44')), new Map([['phone', '0044 20 7946 0018']]))).toBe('+44 20 7946 0018');
    expect(formPhone(formWith(code('44', '')), new Map([['phone', '0044 20 7946 0018']]))).toBe('+44 20 7946 0018');
    const html = String(phoneField(createTranslator(locales.en ?? {}), { label: 'Phone', country: 'CA' }));
    const optionOf = (value: string) => new RegExp(`<option value="${value}"[^>]*>`).exec(html)?.[0] ?? '';
    for (const [region, typed] of cases) {
      const option = optionOf(region);
      const prefix = /data-international-prefix="([^"]*)"/.exec(option)?.[1];
      const keep = option.includes('data-keep-prefix="true"');
      const selected = code(callingCode(region)!, prefix, keep);
      expect(formPhone(formWith(selected), new Map([['phone', typed]])), `${region} ${typed}`).toBe(joinPhone(region, typed));
    }
  });
  it('autofills the number as a full phone number and leaves the country select without autocomplete', () => {
    const html = String(phoneField(createTranslator(locales.en ?? {}), { label: 'Phone', country: 'GB' }));
    expect(/<select[^>]*name="phoneCountry"[^>]*>/.exec(html)?.[0]).not.toContain('autocomplete');
    expect(/<input[^>]*name="phone"[^>]*>/.exec(html)?.[0]).toContain('autocomplete="tel"');
  });
  it('is in both scripts, which send the joined phone only when there is one', () => {
    for (const script of [joinBrowserScript, publicBrowserScript]) {
      expect(script).toContain(phoneScript);
      expect(script).toContain('formPhone(form, fields)');
    }
  });
});

describe('join and drop-in refusals', () => {
  const refusal = new Function(refusalScript + '\nreturn refusal;')() as (response: Response) => Promise<string>;
  it('says to retry only a full queue\'s 429, and calls any other 429 a limit', async () => {
    const busy = Response.json({ error: { code: 'rate_limited', details: { reason: ['busy'] } } }, { status: 429, headers: { 'Retry-After': '1' } });
    expect(await refusal(busy)).toBe('retry');
    expect(await refusal(Response.json({ error: { code: 'rate_limited', details: { reason: ['intake_ceiling'] } } }, { status: 429 }))).toBe('intakeLimited');
    expect(await refusal(Response.json({ error: { code: 'rate_limited' } }, { status: 429, headers: { 'Retry-After': '900' } }))).toBe('limited');
    expect(await refusal(new Response('not json', { status: 429 }))).toBe('limited');
    expect(await refusal(Response.json({ error: { code: 'conflict' } }, { status: 409 }))).toBe('conflict');
    expect(await refusal(Response.json({ error: { code: 'internal' } }, { status: 500 }))).toBe('failed');
  });
  it('shows the code message for a refused promo code, reuses the admission without it, and reviews a join with a code', () => {
    expect(joinBrowserScript).toContain("reason.includes('code_refused')) throw new Error('codeRefused')");
    expect(joinBrowserScript).toContain('(code && cached.code !== code)');
    expect(joinBrowserScript).toContain("window.location.assign(code ? '/join/review' : '/join/checkout')");
  });
  it('is what both scripts use for a refused post', () => {
    for (const script of [joinBrowserScript, publicBrowserScript]) {
      expect(script).toContain(refusalScript);
      expect(script).toContain('await refusal(response)');
    }
  });
});

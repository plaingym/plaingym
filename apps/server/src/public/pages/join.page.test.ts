// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { joinStatusPage, type JoinPageState } from './join.page.js';

const t = createTranslator(locales.en ?? {});
const gym = { name: 'Demo academy', revision: 1, logoKey: null, primaryColor: null };
const render = async (state: JoinPageState, testCardHint?: string) =>
  String(await joinStatusPage({ gym, t, state, ...(testCardHint ? { testCardHint } : {}) }));

/** The one actions row, so a second row or an unwrapped action fails the test. */
function actionsRow(html: string) {
  const rows = [...html.matchAll(/<div class="flex flex-wrap items-center gap-3" data-join-actions(?:="[^"]*")?>([\s\S]*?)<\/div>/g)];
  expect(rows).toHaveLength(1);
  return rows[0]![1]!;
}

describe('join status page cancelled actions', () => {
  it.each([
    ['cancelled', 'Pay securely'],
    ['cancelledCard', 'Save card securely'],
  ] as const)('puts the %s action and Start again in one wrapping row', async (state, label) => {
    const html = await render(state), row = actionsRow(html);
    expect(row.match(/<a /g)).toHaveLength(2);
    expect(row).toMatch(new RegExp(`<a href="/join/checkout" class="[^"]*">${label}</a>`));
    expect(row).toMatch(/<a href="\/join" class="[^"]*">Start again<\/a>/);
    expect(row.indexOf('href="/join/checkout"')).toBeLessThan(row.indexOf('href="/join"'));
  });

  it.each(['failed', 'missing', 'continue'] as const)('leaves the %s page without an actions row', async state => {
    expect(await render(state)).not.toContain('data-join-actions');
  });

  it('keeps the demo test-card hint before the cancelled actions row', async () => {
    const html = await render('cancelled', '4242 4242 4242 4242');
    actionsRow(html);
    expect(html).toContain('4242 4242 4242 4242');
    expect(html.indexOf('data-demo-test-card')).toBeLessThan(html.indexOf('data-join-actions'));
  });
});

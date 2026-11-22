// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTranslator } from '@plaingym/shared';
import { locales } from '@plaingym/shared/locales';
import { joinFormPage } from './join.page.js';

// jsdom gives external modules the page's http import.meta.url, so a server module that reads a file through
// fileURLToPath cannot load. Both mocks only replace values the form and script do not exercise here: the body limit
// and the footer's running version. The script still has the same body limit the service declares.
vi.mock('./join.service.js', () => ({ joinBodyBytes: 4 * 1024 * 1024 }));
vi.mock('../../areas/health/version.js', () => ({ runningVersion: () => ({ version: '0.4.0', commit: 'test' }) }));
const { joinBrowserScript } = await import('./join.browser.js');

const t = createTranslator(locales.en ?? {});
const gym = { name: 'Academy', revision: 1, logoKey: null, primaryColor: null };
const now = new Date('2026-11-07T12:00:00Z');
// The same document fixtures as document-view.test.ts; one template unless a case renders more.
const templates = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `Terms ${i}`, version: 1, kind: 'waiver' as const, body: '', retiredAt: null, createdAt: now.toISOString(),
  document: { key: `gym/waivers/templates/${i}.pdf`, hash: 'c'.repeat(64), pages: 1, bytes: 1000 } }));
const plan = { id: 'plan', name: 'Training', amountCents: 10000, currency: 'USD', interval: 'monthly' as const, plusTax: false, signupFeeCents: 0, trialDays: 0, commitmentMonths: null, revision: 1 };
/** Renders the join form, runs the served script against it, and leaves the document for the case to type into. */
function load(options: { count?: number; templates?: typeof templates; values?: Record<string, string> } = {}) {
  document.documentElement.innerHTML = joinFormPage({ gym, t, plan, count: options.count ?? 1,
    templates: options.templates ?? templates.slice(0, 1), ...(options.values ? { values: options.values } : {}) });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '' } as unknown as CanvasRenderingContext2D);
  new Function(joinBrowserScript)();
}
const field = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const type = (name: string, value: string) => {
  const element = field(name);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};
const values = (...names: string[]) => names.map(name => field(name).value);

afterEach(() => { vi.restoreAllMocks(); document.documentElement.innerHTML = ''; });

describe('one person fills their name from the contact name', () => {
  it('fills the first name, the rest as the last name, and the full name as the signer name', () => {
    load();
    type('contactName', 'Ann Marie Lee');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Ann', 'Marie Lee', 'Ann Marie Lee']);
  });

  it('trims and collapses whitespace before splitting', () => {
    load();
    type('contactName', '  Ann   Lee ');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Ann', 'Lee', 'Ann Lee']);
  });

  it('fills only the first name from a single word', () => {
    load();
    type('contactName', 'Ann');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Ann', '', 'Ann']);
  });

  it('keeps a typed first name and still fills the other fields', () => {
    load();
    type('contactName', 'Ann Lee');
    type('member-0-firstName', 'Jo');
    type('contactName', 'Bo Ng');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Jo', 'Ng', 'Bo Ng']);
  });

  it('never refills a field the visitor cleared', () => {
    load();
    type('contactName', 'Ann Lee');
    type('member-0-lastName', '');
    type('contactName', 'Ann Lees');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Ann', '', 'Ann Lees']);
  });

  it('fills every waiver signer name', () => {
    load({ templates: templates.slice(0, 2) });
    type('contactName', 'Ann Lee');
    expect(values('waiver-0-0-name', 'waiver-0-1-name')).toEqual(['Ann Lee', 'Ann Lee']);
  });

  it('never fills a form with more than one person', () => {
    load({ count: 2 });
    type('contactName', 'Ann Lee');
    expect(values('member-0-firstName', 'member-0-lastName', 'member-1-firstName', 'member-1-lastName', 'waiver-0-0-name', 'waiver-1-0-name'))
      .toEqual(['', '', '', '', '', '']);
  });

  it('keeps names the server rendered after a refused submission', () => {
    load({ values: { 'member-0-firstName': 'Posted', 'waiver-0-0-template': '0', 'waiver-0-0-version': '1', 'waiver-0-0-name': 'Signer' } });
    type('contactName', 'Ann Lee');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Posted', 'Lee', 'Signer']);
  });

  it('keeps a value set without an input event, as browser autofill does', () => {
    load();
    field('member-0-firstName').value = 'Autofilled';
    type('contactName', 'Ann Lee');
    expect(values('member-0-firstName', 'member-0-lastName', 'waiver-0-0-name')).toEqual(['Autofilled', 'Lee', 'Ann Lee']);
  });
});
